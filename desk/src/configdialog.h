#ifndef CONFIGDIALOG_H
#define CONFIGDIALOG_H

#include <QDialog>
#include <QJsonObject>
#include <QMap>
#include <QStringList>

class QLineEdit;

/// 参数编辑对话框：字段留空表示"不修改该项"，
/// collectedValues() 只返回用户填写的非空字段。
class ConfigDialog : public QDialog
{
    Q_OBJECT

public:
    /// keys 为要显示的参数键（如 {"wifi.ssid","wifi.password"}）。
    explicit ConfigDialog(const QStringList &keys, QWidget *parent = nullptr);

    /// 收集非空字段；mqtt.port 转为整数，其余存字符串。
    QJsonObject collectedValues() const;

private:
    QMap<QString, QLineEdit *> m_edits;
};

#endif // CONFIGDIALOG_H
