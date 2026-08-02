#include "configdialog.h"

#include <QDialogButtonBox>
#include <QFormLayout>
#include <QIntValidator>
#include <QLineEdit>

namespace {

QString displayLabel(const QString &key)
{
    if (key == "gateway.name")    return "网关名称";
    if (key == "wifi.ssid")       return "WiFi 名称";
    if (key == "wifi.password")   return "WiFi 密码";
    if (key == "mqtt.host")       return "MQTT 服务器";
    if (key == "mqtt.port")       return "MQTT 端口";
    if (key == "mqtt.username")   return "MQTT 用户名";
    if (key == "mqtt.password")   return "MQTT 密码";
    return key;
}

bool isPasswordKey(const QString &key)
{
    return key == "wifi.password" || key == "mqtt.password";
}

}  // namespace

ConfigDialog::ConfigDialog(const QStringList &keys, QWidget *parent)
    : QDialog(parent)
{
    setWindowTitle("参数设置");

    auto *form = new QFormLayout(this);

    for (const QString &key : keys) {
        auto *edit = new QLineEdit(this);
        edit->setPlaceholderText("留空则不修改");
        if (isPasswordKey(key))
            edit->setEchoMode(QLineEdit::Password);
        if (key == "mqtt.port")
            edit->setValidator(new QIntValidator(1, 65535, this));
        m_edits.insert(key, edit);
        form->addRow(displayLabel(key) + ":", edit);
    }

    auto *buttons = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel,
                                         this);
    connect(buttons, &QDialogButtonBox::accepted, this, &QDialog::accept);
    connect(buttons, &QDialogButtonBox::rejected, this, &QDialog::reject);
    form->addRow(buttons);
}

QJsonObject ConfigDialog::collectedValues() const
{
    QJsonObject values;
    for (auto it = m_edits.constBegin(); it != m_edits.constEnd(); ++it) {
        const QString text = it.value()->text().trimmed();
        if (text.isEmpty())
            continue;   // 空值 = 不修改该项

        if (it.key() == "mqtt.port") {
            bool ok = false;
            const int port = text.toInt(&ok);
            if (ok)
                values[it.key()] = port;
            continue;
        }
        values[it.key()] = text;
    }
    return values;
}
