/* 服务入口：Express 应用 + MQTT 客户端 + 每日历史清理。
 *
 * 启动：node server.js   （或 npm start）
 * 依赖：config.json（缺失则用 config.example.json 默认值） */
const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const mqttClient = require('./mqtt');
const nodesRouter = require('./routes/nodes');
const telemetryRouter = require('./routes/telemetry');
const layoutRouter = require('./routes/layout');
const panelsRouter = require('./routes/panels');
const settingsRouter = require('./routes/settings');
const statusRouter = require('./routes/status');
const mqttRouter = require('./routes/mqtt');

const cfg = config.load();

// 初始化数据库
db.init(cfg);

// 为既有连接补齐主题面板（新库无连接时 no-op；幂等，只影响配置/布局，不影响已有数据）
for (const conn of db.listMqttConnections()) {
  db.syncTopicPanels(conn.id, conn.topics);
}

const app = express();
app.locals.cfg = cfg;
app.locals.startTime = Date.now();

app.use(express.json());

// API 路由
app.use('/api/nodes', nodesRouter);
app.use('/api/telemetry', telemetryRouter);
app.use('/api/layout', layoutRouter);
app.use('/api/panels', panelsRouter);
app.use('/api/settings', settingsRouter.router);
app.use('/api/status', statusRouter);
app.use('/api/mqtt', mqttRouter);

// 静态资源：背景图 + Vue 单页
app.use('/uploads', express.static(cfg.storage.upload_dir));
app.use(express.static(path.join(__dirname, 'public')));

// 统一错误处理（multer 上传、JSON 解析等）
app.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ detail: `图片超过 ${cfg.storage.max_upload_mb}MB 限制` });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ detail: '请求体不是合法 JSON' });
  }
  const msg = (err && err.message) || '服务器内部错误';
  console.error('请求处理错误:', msg);
  res.status(400).json({ detail: msg });
});

// 启动 MQTT 订阅（连接参数来自数据库 settings，默认本地 127.0.0.1）
mqttClient.start();

// 历史数据清理（保留天数配置）
function scheduleCleanup() {
  const days = cfg.database.retention_days;
  if (days > 0) {
    try {
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const info = db.cleanupTelemetry(cutoff);
      if (info.changes > 0) console.log(`已清理 ${info.changes} 条超过 ${days} 天的历史数据`);
    } catch (err) {
      console.error('历史数据清理失败:', err);
    }
  }
  setInterval(scheduleCleanup, 24 * 60 * 60 * 1000);
}
scheduleCleanup();

const server = app.listen(cfg.server.port, cfg.server.host, () => {
  console.log(`服务已启动: http://${cfg.server.host}:${cfg.server.port}`);
});

// 优雅退出
function shutdown() {
  console.log('正在停止服务…');
  mqttClient.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
