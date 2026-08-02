#include "mainwindow.h"

#include "configdialog.h"

#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QTimer>
#include <QMessageBox>
#include <QDateTime>
#include <QJsonObject>
#include <QJsonDocument>
#include <QScrollBar>
#include <QMenu>
#include <QAction>
#include <QSplitter>

// 通用波特率列表
static const int kBaudRates[] = {
    1200, 2400, 4800, 9600, 19200, 38400,
    57600, 115200, 230400, 460800, 921600
};

static const char kStyleBtn[] =
    "QPushButton { padding: 4px 12px; }";

MainWindow::MainWindow(QWidget *parent)
    : QMainWindow(parent)
    , m_serial(new SerialPort(this))
    , m_protocol(new Protocol(this))
{
    setupUI();

    // 串口 → 接收区（气泡靠左）
    connect(m_serial, &SerialPort::dataReceived,
            this, &MainWindow::onSerialDataReceived);

    // 协议 → 加载到发送输入框（人工点"发送"才发出）
    connect(m_protocol, &Protocol::writeRequest,
            this, [this](const QByteArray &line) {
                QJsonParseError err;
                QJsonDocument doc = QJsonDocument::fromJson(line, &err);
                if (err.error == QJsonParseError::NoError) {
                    m_sendEdit->setPlainText(
                        doc.toJson(QJsonDocument::Indented).trimmed());
                } else {
                    m_sendEdit->setPlainText(QString::fromUtf8(line).trimmed());
                }
                appendLog("命令已加载到发送框", "#f1fa8c");
            });

    // 协议解析结果 → 日志区
    connect(m_protocol, &Protocol::allConfigReceived, this,
            [this](const QJsonObject &values) {
                QString json = QJsonDocument(values).toJson(QJsonDocument::Indented);
                appendLog("--- 全部配置 ---\n" + json, "#8be9fd");
            });

    connect(m_protocol, &Protocol::paramReceived, this,
            [this](const QString &param, const QJsonValue &value) {
                appendLog(QString("读取 %1 = %2").arg(param, value.toString()), "#50fa7b");
            });

    connect(m_protocol, &Protocol::setResult, this,
            [this](const QString &param, bool ok, bool changed, bool persisted, bool rebootReq) {
                QString msg = QString("设置 %1 → %2 | changed=%3 persisted=%4 reboot=%5")
                                  .arg(param, ok ? "✓" : "✗")
                                  .arg(changed).arg(persisted).arg(rebootReq);
                appendLog(msg, ok ? "#50fa7b" : "#ff5555");
            });

    connect(m_protocol, &Protocol::setBatchResult, this,
            [this](bool ok, int changed, bool persisted) {
                QString msg = QString("批量设置 → %1 | changed=%2 persisted=%3")
                                  .arg(ok ? "✓" : "✗").arg(changed).arg(persisted);
                appendLog(msg, ok ? "#50fa7b" : "#ff5555");
            });

    connect(m_protocol, &Protocol::rebootResult, this,
            [this]() {
                appendLog("设备即将重启", "#ffb86c");
            });

    connect(m_protocol, &Protocol::bootReceived, this,
            [this](const QString &gateway) {
                appendLog(QString("设备已重启上线（%1）").arg(gateway), "#50fa7b");
            });

    connect(m_protocol, &Protocol::errorReceived, this,
            [this](int /*id*/, const QString &code, const QString &param, const QString &msg) {
                appendLog(QString("错误 [%1] %2: %3").arg(code, param, msg), "#ff5555");
            });

    // 启动后刷新串口
    QTimer::singleShot(100, this, &MainWindow::onRefreshPorts);
}

MainWindow::~MainWindow()
{
}

// ===================================================================
//  UI 搭建
// ===================================================================

void MainWindow::setupUI()
{
    auto *centralWidget = new QWidget(this);
    auto *mainLayout = new QVBoxLayout(centralWidget);
    mainLayout->setContentsMargins(12, 12, 12, 12);
    mainLayout->setSpacing(8);

    // ---- 1. 顶部连接区 ----
    m_connGroup = new QGroupBox("串口连接", this);
    auto *connLayout = new QHBoxLayout(m_connGroup);
    connLayout->setSpacing(8);

    connLayout->addWidget(new QLabel("串口:", this));
    m_portCombo = new QComboBox(this);
    m_portCombo->setMinimumWidth(220);
    m_portCombo->setPlaceholderText("选择串口…");
    connLayout->addWidget(m_portCombo);

    m_refreshBtn = new QPushButton("刷新", this);
    m_refreshBtn->setFixedWidth(60);
    connect(m_refreshBtn, &QPushButton::clicked, this, &MainWindow::onRefreshPorts);
    connLayout->addWidget(m_refreshBtn);

    connLayout->addWidget(new QLabel("波特率:", this));
    m_baudCombo = new QComboBox(this);
    m_baudCombo->setMinimumWidth(110);
    for (int rate : kBaudRates)
        m_baudCombo->addItem(QString::number(rate), rate);
    m_baudCombo->setCurrentText("115200");
    connLayout->addWidget(m_baudCombo);

    connLayout->addStretch();

    m_connBtn = new QPushButton("连接", this);
    m_connBtn->setFixedWidth(80);
    m_connBtn->setStyleSheet("QPushButton { font-weight: bold; }");
    connect(m_connBtn, &QPushButton::clicked, this, &MainWindow::onConnectToggle);
    connLayout->addWidget(m_connBtn);

    mainLayout->addWidget(m_connGroup);

    // ---- 2. 功能工具栏 ----
    m_funcBar = new QWidget(this);
    auto *funcLayout = new QHBoxLayout(m_funcBar);
    funcLayout->setContentsMargins(0, 0, 0, 0);
    funcLayout->setSpacing(6);

    auto *funcLabel = new QLabel("功能:", this);
    funcLabel->setStyleSheet("font-weight: bold;");
    funcLayout->addWidget(funcLabel);

    m_btnQueryAll = new QPushButton("查询全部配置", this);
    m_btnQueryAll->setStyleSheet(kStyleBtn);
    connect(m_btnQueryAll, &QPushButton::clicked, this, &MainWindow::onQueryAllConfig);
    funcLayout->addWidget(m_btnQueryAll);

    m_btnSetGateway = new QPushButton("设置网关名称", this);
    m_btnSetGateway->setStyleSheet(kStyleBtn);
    connect(m_btnSetGateway, &QPushButton::clicked, this, &MainWindow::onSetGatewayName);
    funcLayout->addWidget(m_btnSetGateway);

    m_btnSetWiFi = new QPushButton("设置WiFi", this);
    m_btnSetWiFi->setStyleSheet(kStyleBtn);
    connect(m_btnSetWiFi, &QPushButton::clicked, this, &MainWindow::onSetWiFi);
    funcLayout->addWidget(m_btnSetWiFi);

    m_btnSetMQTT = new QPushButton("设置MQTT", this);
    m_btnSetMQTT->setStyleSheet(kStyleBtn);
    connect(m_btnSetMQTT, &QPushButton::clicked, this, &MainWindow::onSetMQTT);
    funcLayout->addWidget(m_btnSetMQTT);

    m_btnReboot = new QPushButton("重启设备", this);
    m_btnReboot->setStyleSheet("QPushButton { padding: 4px 12px; color: #ff5555; }");
    connect(m_btnReboot, &QPushButton::clicked, this, &MainWindow::onReboot);
    funcLayout->addWidget(m_btnReboot);

    funcLayout->addStretch();

    mainLayout->addWidget(m_funcBar);

    // ---- 3/4. 接收区 + 发送区（可拖拽分隔） ----
    auto *receiveLabel = new QLabel("接收", this);
    receiveLabel->setStyleSheet("font-weight: bold;");
    mainLayout->addWidget(receiveLabel);

    auto *splitter = new QSplitter(Qt::Vertical, this);

    m_receiveView = new QTextEdit(this);
    m_receiveView->setReadOnly(true);
    m_receiveView->setPlaceholderText("串口收发数据将显示在这里…");
    m_receiveView->setStyleSheet(
        "QTextEdit {"
        "  font-family: 'Menlo', 'monospace';"
        "  font-size: 13px;"
        "  background: #1e1e2e;"
        "}"
    );

    // 右键菜单（清空）
    m_receiveView->setContextMenuPolicy(Qt::CustomContextMenu);
    connect(m_receiveView, &QWidget::customContextMenuRequested,
            this, [this](const QPoint &pos) {
                QMenu menu;
                QAction *clearAction = menu.addAction("清空接收");
                connect(clearAction, &QAction::triggered,
                        this, &MainWindow::onClearReceive);
                menu.exec(m_receiveView->mapToGlobal(pos));
            });

    splitter->addWidget(m_receiveView);

    // 发送区
    auto *sendWidget = new QWidget(this);
    auto *sendLayout = new QHBoxLayout(sendWidget);
    sendLayout->setContentsMargins(0, 0, 0, 0);
    sendLayout->setSpacing(6);

    m_sendEdit = new QPlainTextEdit(this);
    m_sendEdit->setPlaceholderText("输入要发送的数据…");
    m_sendEdit->setStyleSheet(
        "QPlainTextEdit {"
        "  font-family: 'Menlo', 'monospace';"
        "  font-size: 13px;"
        "}"
    );
    sendLayout->addWidget(m_sendEdit, 1);

    m_sendBtn = new QPushButton("发送", this);
    m_sendBtn->setFixedWidth(80);
    m_sendBtn->setEnabled(false);
    m_sendBtn->setStyleSheet(
        "QPushButton { font-size: 15px; font-weight: bold; }");
    connect(m_sendBtn, &QPushButton::clicked, this, &MainWindow::onSendData);
    sendLayout->addWidget(m_sendBtn);

    splitter->addWidget(sendWidget);

    mainLayout->addWidget(splitter, 1);

    // ---- 5. 底部：操作日志 ----
    auto *logLabel = new QLabel("操作日志", this);
    logLabel->setStyleSheet("font-weight: bold; color: #6272a4;");
    mainLayout->addWidget(logLabel);

    m_logView = new QTextEdit(this);
    m_logView->setReadOnly(true);
    m_logView->setMaximumHeight(100);
    m_logView->setPlaceholderText("操作日志将显示在这里…");
    m_logView->setStyleSheet(
        "QTextEdit {"
        "  font-family: 'Menlo', 'monospace';"
        "  font-size: 12px;"
        "  background: #f8f9fa; color: #555;"
        "  border: 1px solid #ddd;"
        "  padding: 4px;"
        "}"
    );
    // 右键菜单（清空）
    m_logView->setContextMenuPolicy(Qt::CustomContextMenu);
    connect(m_logView, &QWidget::customContextMenuRequested,
            this, [this](const QPoint &pos) {
                QMenu menu;
                QAction *clearAction = menu.addAction("清空日志");
                connect(clearAction, &QAction::triggered,
                        this, &MainWindow::onClearLog);
                menu.exec(m_logView->mapToGlobal(pos));
            });
    mainLayout->addWidget(m_logView);

    setCentralWidget(centralWidget);

    setWindowTitle("全屋温湿度监控");
    resize(900, 680);
}

// ===================================================================
//  串口连接
// ===================================================================

void MainWindow::refreshPortList()
{
    m_portCombo->clear();
    auto ports = SerialPort::availablePorts();
    for (const auto &p : ports)
        m_portCombo->addItem(p.description, p.portName);
    if (ports.isEmpty())
        m_portCombo->addItem("(未检测到串口)");
}

void MainWindow::onRefreshPorts()
{
    QString current = m_portCombo->currentData().toString();
    refreshPortList();
    int idx = m_portCombo->findData(current);
    if (idx >= 0) m_portCombo->setCurrentIndex(idx);
}

void MainWindow::setConnUiConnected(bool connected)
{
    if (connected) {
        m_connBtn->setText("断开");
        m_connBtn->setStyleSheet("QPushButton { font-weight: bold; color: red; }");
        m_portCombo->setEnabled(false);
        m_baudCombo->setEnabled(false);
        m_refreshBtn->setEnabled(false);
        m_sendBtn->setEnabled(true);
    } else {
        m_connBtn->setText("连接");
        m_connBtn->setStyleSheet("QPushButton { font-weight: bold; }");
        m_portCombo->setEnabled(true);
        m_baudCombo->setEnabled(true);
        m_refreshBtn->setEnabled(true);
        m_sendBtn->setEnabled(false);
    }
}

void MainWindow::onConnectToggle()
{
    if (m_serial->isOpen()) {
        m_serial->close();
        setConnUiConnected(false);
        appendLog("串口已断开", "#6272a4");
        return;
    }

    if (m_portCombo->count() == 0 ||
        m_portCombo->currentData().toString().isEmpty()) {
        QMessageBox::warning(this, "提示", "请选择一个可用的串口");
        return;
    }

    QString portName = m_portCombo->currentData().toString();
    int baud = m_baudCombo->currentData().toInt();

    if (m_serial->open(portName, baud)) {
        setConnUiConnected(true);
        appendLog(QString("已连接 %1 @ %2").arg(portName).arg(baud), "#6272a4");
    } else {
        QMessageBox::critical(this, "错误",
                              QString("连接串口 %1 失败").arg(portName));
    }
}

// ===================================================================
//  协议命令
// ===================================================================

void MainWindow::onQueryAllConfig()
{
    m_protocol->sendGetAll();
}

void MainWindow::onSetGatewayName()
{
    ConfigDialog dlg({"gateway.name"}, this);
    if (dlg.exec() != QDialog::Accepted) return;

    QJsonObject values = dlg.collectedValues();
    if (values.isEmpty()) {
        appendLog("未填写网关名称，未修改", "#6272a4");
        return;
    }
    m_protocol->sendSet("gateway.name", values["gateway.name"]);
}

void MainWindow::onSetWiFi()
{
    ConfigDialog dlg({"wifi.ssid", "wifi.password"}, this);
    if (dlg.exec() != QDialog::Accepted) return;

    QJsonObject values = dlg.collectedValues();
    if (values.isEmpty()) {
        appendLog("未填写任何 WiFi 参数，未修改", "#6272a4");
        return;
    }
    m_protocol->sendSetBatch(values);
}

void MainWindow::onSetMQTT()
{
    ConfigDialog dlg({"mqtt.host", "mqtt.port", "mqtt.username", "mqtt.password"}, this);
    if (dlg.exec() != QDialog::Accepted) return;

    QJsonObject values = dlg.collectedValues();
    if (values.isEmpty()) {
        appendLog("未填写任何 MQTT 参数，未修改", "#6272a4");
        return;
    }
    m_protocol->sendSetBatch(values);
}

void MainWindow::onReboot()
{
    auto ret = QMessageBox::question(this, "确认重启",
                                      "确认要重启设备吗？\n设备重启后串口连接将断开。",
                                      QMessageBox::Yes | QMessageBox::No,
                                      QMessageBox::No);
    if (ret != QMessageBox::Yes) return;

    m_protocol->sendReboot();
}

// ===================================================================
//  接收 / 发送
// ===================================================================

void MainWindow::onSerialDataReceived(const QByteArray &data)
{
    QString readable;
    bool allPrintable = true;
    for (char c : data) {
        unsigned char uc = (unsigned char)c;
        if (uc < 32 && uc != '\n' && uc != '\r' && uc != '\t') {
            allPrintable = false;
            break;
        }
    }
    if (allPrintable) {
        readable = QString::fromUtf8(data).trimmed();
    } else {
        QString hex;
        for (char c : data)
            hex += QString::asprintf("%02X ", (unsigned char)c);
        readable = hex.trimmed();
    }

    QString ts = QDateTime::currentDateTime().toString("HH:mm:ss.zzz");
    appendBubble(QString("[%1] %2").arg(ts, readable), false);

    // 同时喂给协议解析器
    m_protocol->feedData(data);
}

void MainWindow::onSendData()
{
    if (!m_serial->isOpen()) return;
    QString text = m_sendEdit->toPlainText();
    if (text.isEmpty()) return;

    QByteArray data;
    if (text.trimmed().startsWith('{') || text.trimmed().startsWith('[')) {
        QJsonParseError err;
        QJsonDocument doc = QJsonDocument::fromJson(text.toUtf8(), &err);
        if (err.error == QJsonParseError::NoError) {
            data = doc.toJson(QJsonDocument::Compact);
        } else {
            data = text.toUtf8();
        }
        if (!data.endsWith('\n'))
            data.append('\n');
    } else {
        data = text.toUtf8();
    }

    m_serial->write(data);

    // 发送的内容也显示到接收区（气泡靠右）
    QString ts = QDateTime::currentDateTime().toString("HH:mm:ss.zzz");
    appendBubble(QString("[%1] → %2").arg(ts, QString::fromUtf8(data).trimmed()), true);

    appendLog("手动发送: " + QString::fromUtf8(data).trimmed(), "#8be9fd");
}

void MainWindow::onClearReceive()
{
    m_receiveView->clear();
}

// ===================================================================
//  气泡
// ===================================================================

void MainWindow::appendBubble(const QString &text, bool sent)
{
    QString escaped = text.toHtmlEscaped().replace('\n', "<br>");

    QString html;
    if (sent) {
        // 靠右，绿色气泡
        html = QString(
            "<table width='100%'><tr>"
            "<td>"
            "  <table align='right' style='background: #2d5a27; border-radius: 10px;"
            "              padding: 6px 12px; margin: 2px 0;'>"
            "    <tr><td style='color: #a6e3a1; white-space: pre-wrap;'>%1</td></tr>"
            "  </table>"
            "</td>"
            "</tr></table>"
        ).arg(escaped);
    } else {
        // 靠左，深色气泡
        html = QString(
            "<table width='100%'><tr>"
            "<td>"
            "  <table style='background: #313244; border-radius: 10px;"
            "              padding: 6px 12px; margin: 2px 0;'>"
            "    <tr><td style='color: #cdd6f4; white-space: pre-wrap;'>%1</td></tr>"
            "  </table>"
            "</td>"
            "</tr></table>"
        ).arg(escaped);
    }

    // 移动到末尾插入
    QTextCursor cursor(m_receiveView->document());
    cursor.movePosition(QTextCursor::End);
    cursor.insertHtml(html);
    // 空行分隔
    cursor.insertHtml("<br>");

    // 自动滚到底
    auto sb = m_receiveView->verticalScrollBar();
    sb->setValue(sb->maximum());
}

// ===================================================================
//  日志
// ===================================================================

void MainWindow::appendLog(const QString &text, const QString &color)
{
    QString ts = QDateTime::currentDateTime().toString("HH:mm:ss");
    QString html;
    if (color.isEmpty()) {
        html = QString("<span>[%1] %2</span>").arg(ts, text.toHtmlEscaped());
    } else {
        html = QString("<span style='color:%1;'>[%2] %3</span>")
                   .arg(color, ts, text.toHtmlEscaped());
    }
    m_logView->append(html);

    auto sb = m_logView->verticalScrollBar();
    sb->setValue(sb->maximum());
}

void MainWindow::onClearLog()
{
    m_logView->clear();
}
