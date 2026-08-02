/* MQTT 服务配置路由：Web 端读取/修改 broker 连接参数（保存后自动重连）。 */
const express = require('express');
const db = require('../db');
const mqttClient = require('../mqtt');

const router = express.Router();

function mqttToJson() {
  const m = db.getMqttSettings();
  const st = mqttClient.status();
  return {
    host: m.host,
    port: m.port,
    username: m.username,
    password_set: !!m.password,   // 不回传明文密码
    connected: st.connected,
    last_error: st.lastError,
  };
}

router.get('/', (_req, res) => {
  res.json(mqttToJson());
});

router.put('/', (req, res) => {
  const body = req.body || {};

  const host = String(body.host == null ? '' : body.host).trim();
  if (!host) return res.status(400).json({ detail: '服务器地址不能为空' });
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ detail: '端口需为 1-65535 的整数' });
  }
  const username = typeof body.username === 'string' ? body.username : '';

  // 密码语义：clear_password=true 清除；password 非空则设置；否则保持不变
  let password;
  if (body.clear_password === true) password = '';
  else if (typeof body.password === 'string' && body.password) password = body.password;

  db.saveMqttSettings({ host, port, username, password });
  mqttClient.reconnect();

  res.json(mqttToJson());
});

module.exports = router;
