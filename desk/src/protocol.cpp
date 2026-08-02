#include "protocol.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QJsonArray>
#include <QDebug>

Protocol::Protocol(QObject *parent)
    : QObject(parent)
{
}

QByteArray Protocol::buildRequest(const QString &cmd,
                                  const QString &param,
                                  const QJsonValue &value,
                                  const QJsonObject &values)
{
    QJsonObject obj;
    obj["v"]   = 1;
    obj["id"]  = m_nextId++;
    obj["cmd"] = cmd;

    if (!param.isEmpty())
        obj["param"] = param;

    if (!value.isNull())
        obj["value"] = value;

    if (!values.isEmpty())
        obj["values"] = values;

    QByteArray line = QJsonDocument(obj).toJson(QJsonDocument::Compact);
    line.append('\n');
    return line;
}

// ---------- 公开 API ----------

void Protocol::sendGet(const QString &param)
{
    QByteArray req = buildRequest("get", param);
    emit writeRequest(req);
}

void Protocol::sendGetAll()
{
    sendGet("*");
}

void Protocol::sendSet(const QString &param, const QJsonValue &value)
{
    QByteArray req = buildRequest("set", param, value);
    emit writeRequest(req);
}

void Protocol::sendSetBatch(const QJsonObject &values)
{
    QByteArray req = buildRequest("set_batch", QString(), QJsonValue(), values);
    emit writeRequest(req);
}

void Protocol::sendReboot()
{
    QByteArray req = buildRequest("reboot");
    emit writeRequest(req);
}

void Protocol::feedData(const QByteArray &data)
{
    m_buffer.append(data);

    // 按 \n 分帧（兼容 \r\n）
    while (true) {
        int idx = m_buffer.indexOf('\n');
        if (idx < 0) break;

        QByteArray line = m_buffer.left(idx);
        // 去掉行尾 \r
        if (line.endsWith('\r'))
            line.chop(1);
        m_buffer.remove(0, idx + 1);

        if (!line.isEmpty())
            parseLine(line);
    }
}

// ---------- 内部 ----------

void Protocol::parseLine(const QByteArray &line)
{
    QJsonParseError err;
    QJsonDocument doc = QJsonDocument::fromJson(line, &err);

    if (err.error != QJsonParseError::NoError) {
        qWarning() << "Protocol: JSON parse error:" << err.errorString()
                    << "| line:" << line;
        return;
    }

    if (!doc.isObject()) {
        qWarning() << "Protocol: response is not object:" << line;
        return;
    }

    handleResponse(doc.object());
}

void Protocol::handleResponse(const QJsonObject &obj)
{
    emit responseReceived(obj);

    // ok:true 或 ok:false 均可解析
    bool ok = obj.value("ok").toBool(false);

    // 检查错误
    if (!ok && obj.contains("error")) {
        QJsonObject errObj = obj["error"].toObject();
        int id = obj.value("id").toInt(-1);
        emit errorReceived(id,
                           errObj.value("code").toString(),
                           errObj.value("param").toString(),
                           errObj.value("message").toString());
        return;   // 错误不继续派发
    }

    if (!ok) return;

    // 根据 cmd 或字段特征派发
    QString cmd = obj.value("cmd").toString();
    QString event = obj.value("event").toString();

    // 固件主动上报：设备已完成启动（用于重启后确认设备回到在线）
    if (event == "boot") {
        emit bootReceived(obj.value("gateway").toString());
        return;
    }

    // 重启确认：固件新版回复带 cmd:"reboot"；兼容旧版仅有 action:"rebooting"
    if (cmd == "reboot" || obj.value("action").toString() == "rebooting") {
        emit rebootResult();
        return;
    }

    // get / set / set_batch 响应
    // 读取全部参数
    if (obj.contains("values") && cmd == "get") {
        QJsonObject values = obj["values"].toObject();
        if (obj.value("param").toString() == "*") {
            emit allConfigReceived(values);
        }
        return;
    }

    // 读取单个参数
    if (obj.contains("param") && cmd == "get") {
        QString param = obj["param"].toString();
        QJsonValue value = obj["value"];
        emit paramReceived(param, value);
        return;
    }

    // set 响应
    if (cmd == "set") {
        QString param = obj["param"].toString();
        bool changed   = obj.value("changed").toBool(false);
        bool persisted = obj.value("persisted").toBool(false);
        bool rebootReq = obj.value("reboot_required").toBool(false);
        emit setResult(param, true, changed, persisted, rebootReq);
        return;
    }

    // set_batch 响应
    if (cmd == "set_batch") {
        int changed = obj.value("changed").toInt(0);
        bool persisted = obj.value("persisted").toBool(false);
        emit setBatchResult(true, changed, persisted);
        return;
    }
}
