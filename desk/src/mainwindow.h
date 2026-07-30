#ifndef MAINWINDOW_H
#define MAINWINDOW_H

#include <QMainWindow>
#include <QComboBox>
#include <QPushButton>
#include <QGroupBox>
#include <QLabel>
#include <QPlainTextEdit>
#include <QTextEdit>

#include "serialport.h"
#include "protocol.h"

class MainWindow : public QMainWindow
{
    Q_OBJECT

public:
    explicit MainWindow(QWidget *parent = nullptr);
    ~MainWindow();

private slots:
    // 串口连接
    void onRefreshPorts();
    void onConnectToggle();

    // 协议命令
    void onQueryAllConfig();
    void onSetGatewayName();
    void onSetWiFi();
    void onSetMQTT();
    void onReboot();

    // 接收 / 发送
    void onClearReceive();
    void onClearLog();
    void onSendData();

    // 串口 / 协议信号
    void onSerialDataReceived(const QByteArray &data);

private:
    void setupUI();
    void refreshPortList();
    void appendLog(const QString &text, const QString &color = QString());
    void appendBubble(const QString &text, bool sent);
    void setConnUiConnected(bool connected);

    SerialPort  *m_serial;
    Protocol    *m_protocol;

    // 顶部连接区
    QGroupBox   *m_connGroup;
    QComboBox   *m_portCombo;
    QComboBox   *m_baudCombo;
    QPushButton *m_refreshBtn;
    QPushButton *m_connBtn;

    // 功能工具栏
    QWidget     *m_funcBar;
    QPushButton *m_btnQueryAll;
    QPushButton *m_btnSetGateway;
    QPushButton *m_btnSetWiFi;
    QPushButton *m_btnSetMQTT;
    QPushButton *m_btnReboot;

    // 接收区（气泡）
    QTextEdit   *m_receiveView;

    // 发送区
    QPlainTextEdit *m_sendEdit;
    QPushButton    *m_sendBtn;

    // 底部：操作日志
    QTextEdit      *m_logView;
    QPushButton    *m_clearLogBtn;
};

#endif // MAINWINDOW_H
