#include "serialport.h"

#include <QDir>
#include <QFileInfo>
#include <QSocketNotifier>
#include <QTimer>

#include <fcntl.h>
#include <unistd.h>
#include <termios.h>
#include <errno.h>
#include <string.h>

SerialPort::SerialPort(QObject *parent)
    : QObject(parent)
{
}

SerialPort::~SerialPort()
{
    close();
}

QList<SerialPortInfo> SerialPort::availablePorts()
{
    QList<SerialPortInfo> ports;
    QDir dev("/dev");
    // macOS 普通串口设备命名模式
    QStringList filters;
    filters << "cu.*" << "tty.*";
    auto entries = dev.entryList(filters, QDir::System);

    // 过滤掉 Bluetooth 等非物理串口
    for (const auto &name : entries) {
        if (name.startsWith("cu.Bluetooth") ||
            name.startsWith("tty.Bluetooth") ||
            name.startsWith("cu.DWA") ||
            name.startsWith("tty.DWA") ||
            name.startsWith("cu.Cisco") ||
            name.startsWith("tty.Cisco") ||
            name.startsWith("cu.ur") ||
            name.startsWith("tty.ur") ||
            name.contains("Bluetooth") ||
            name.contains("Wireless"))
            continue;

        SerialPortInfo info;
        info.portName = dev.absoluteFilePath(name);
        info.description = name;
        ports.append(info);
    }

    return ports;
}

bool SerialPort::open(const QString &portName, int baudRate)
{
    if (isOpen()) close();

    m_fd = ::open(portName.toUtf8().constData(),
                  O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (m_fd < 0) {
        emit errorOccurred(
            QString("打开串口失败: %1").arg(strerror(errno)));
        return false;
    }

    // 配置 termios
    struct termios tty;
    memset(&tty, 0, sizeof(tty));
    if (tcgetattr(m_fd, &tty) != 0) {
        emit errorOccurred(
            QString("获取串口属性失败: %1").arg(strerror(errno)));
        ::close(m_fd); m_fd = -1;
        return false;
    }

    cfmakeraw(&tty);           // 原始模式
    tty.c_cflag |= CREAD | CLOCAL;  // 启用接收，忽略调制解调器控制
    tty.c_cflag &= ~CSTOPB;    // 1 stop bit
    tty.c_cflag &= ~PARENB;    // 无校验
    tty.c_cflag &= ~CSIZE;
    tty.c_cflag |= CS8;        // 8 data bits
    tty.c_cc[VMIN]  = 0;       // 非阻塞读
    tty.c_cc[VTIME] = 1;       // 100ms 超时

    // 设置波特率（macOS 的 speed_t 就是整数值，直接传）
    cfsetispeed(&tty, baudRate);
    cfsetospeed(&tty, baudRate);

    if (tcsetattr(m_fd, TCSANOW, &tty) != 0) {
        emit errorOccurred(
            QString("设置串口属性失败: %1").arg(strerror(errno)));
        ::close(m_fd); m_fd = -1;
        return false;
    }

    m_portName = portName;
    m_baudRate = baudRate;

    // 用 QSocketNotifier 异步监听可读事件
    auto *notifier = new QSocketNotifier(m_fd, QSocketNotifier::Read, this);
    connect(notifier, &QSocketNotifier::activated,
            this, &SerialPort::onReadyRead);

    return true;
}

void SerialPort::close()
{
    if (m_fd >= 0) {
        ::close(m_fd);
        m_fd = -1;
    }
    m_portName.clear();
}

qint64 SerialPort::write(const QByteArray &data)
{
    if (!isOpen()) return -1;
    return ::write(m_fd, data.constData(), data.size());
}

void SerialPort::onReadyRead()
{
    QByteArray buf;
    buf.resize(4096);
    int n = ::read(m_fd, buf.data(), buf.size());
    if (n > 0) {
        buf.resize(n);
        emit dataReceived(buf);
    } else if (n < 0 && errno != EAGAIN) {
        emit errorOccurred(
            QString("读取串口错误: %1").arg(strerror(errno)));
    }
}
