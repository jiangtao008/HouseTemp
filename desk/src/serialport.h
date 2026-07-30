#ifndef SERIALPORT_H
#define SERIALPORT_H

#include <QObject>
#include <QString>
#include <QStringList>
#include <QByteArray>

/// 串口信息
struct SerialPortInfo {
    QString portName;  // "/dev/cu.usbmodem..."
    QString description;
};

/// 简单的串口封装（macOS POSIX termios）
class SerialPort : public QObject
{
    Q_OBJECT

public:
    explicit SerialPort(QObject *parent = nullptr);
    ~SerialPort();

    /// 列出当前系统可用串口（扫描 /dev/cu.*）
    static QList<SerialPortInfo> availablePorts();

    /// 打开串口
    bool open(const QString &portName, int baudRate);

    /// 关闭串口
    void close();

    /// 是否已打开
    bool isOpen() const { return m_fd >= 0; }

    /// 发送数据
    qint64 write(const QByteArray &data);

    /// 当前端口名
    QString portName() const { return m_portName; }

signals:
    void dataReceived(const QByteArray &data);
    void errorOccurred(const QString &error);

private slots:
    void onReadyRead();

private:
    int         m_fd = -1;
    QString     m_portName;
    int         m_baudRate = 9600;
};

#endif // SERIALPORT_H
