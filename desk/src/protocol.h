#ifndef PROTOCOL_H
#define PROTOCOL_H

#include <QObject>
#include <QJsonObject>
#include <QJsonValue>
#include <QByteArray>

/// 网关串口 JSON 协议封装
class Protocol : public QObject
{
    Q_OBJECT

public:
    explicit Protocol(QObject *parent = nullptr);

    /// 发送 get 请求
    void sendGet(const QString &param);
    /// 查询全部参数
    void sendGetAll();
    /// 设置单个参数
    void sendSet(const QString &param, const QJsonValue &value);
    /// 批量设置
    void sendSetBatch(const QJsonObject &values);
    /// 重启
    void sendReboot();

    /// 推入串口原始数据，内部按 \n 分帧解析
    void feedData(const QByteArray &data);

signals:
    /// 需要串口发出的原始 JSON 行（外部 SerialPort::write 即可）
    void writeRequest(const QByteArray &line);

    // ====== 解析结果 ======

    void responseReceived(const QJsonObject &msg);
    /// 查询全部参数成功
    void allConfigReceived(const QJsonObject &values);
    /// 查询单个参数成功
    void paramReceived(const QString &param, const QJsonValue &value);
    /// 设置结果
    void setResult(const QString &param, bool ok,
                   bool changed, bool persisted, bool rebootRequired);
    /// 批量设置结果
    void setBatchResult(bool ok, int changed, bool persisted);
    /// 重启结果
    void rebootResult();
    /// 设备上线事件（重启完成后固件主动上报）
    void bootReceived(const QString &gateway);
    /// 错误响应
    void errorReceived(int id, const QString &code,
                       const QString &param, const QString &message);

private:
    void parseLine(const QByteArray &line);
    void handleResponse(const QJsonObject &obj);
    QByteArray buildRequest(const QString &cmd,
                            const QString &param = QString(),
                            const QJsonValue &value = QJsonValue(),
                            const QJsonObject &values = QJsonObject());

    int m_nextId = 1;

    // 累积跨帧数据（实际场景极少出现，但保留）
    QByteArray m_buffer;
};

#endif // PROTOCOL_H
