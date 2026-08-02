/* 运行状态路由：MQTT 连接、服务运行时间、节点数量。 */
const express = require('express');
const db = require('../db');
const mqttClient = require('../mqtt');

const router = express.Router();

router.get('/', (req, res) => {
  const mqttStatus = mqttClient.status();
  res.json({
    mqtt_connected: mqttStatus.connected,
    mqtt_last_error: mqttStatus.lastError,
    uptime_sec: Math.round((Date.now() - req.app.locals.startTime) / 1000),
    node_count: db.listNodes().length,
  });
});

module.exports = router;
