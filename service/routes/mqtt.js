/* MQTT 连接路由：Web 端增删改多条 broker 连接（保存后自动重连对应连接）。 */
const express = require('express');
const db = require('../db');
const mqttClient = require('../mqtt');

const router = express.Router();

/** MQTT 主题合法性校验：# 只能作为最后一个完整层级，+ 必须独占一个层级。 */
function isValidMqttTopic(t) {
  if (typeof t !== 'string' || t.trim() === '') return false;
  if (t.includes('\u0000')) return false;
  const levels = t.split('/');
  for (let i = 0; i < levels.length; i++) {
    const lv = levels[i];
    if (lv.includes('#') && (lv !== '#' || i !== levels.length - 1)) return false;
    if (lv.includes('+') && lv !== '+') return false;
  }
  return true;
}

/** 解析订阅主题：数组或逗号/换行分隔字符串，逐项校验合法性与通配符位置，去空去重。
 * 每项为字符串或 {topic,name,type}，返回归一化后的 [{topic,name,type}]。 */
function parseTopics(value) {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(/[\n,]/);
  const parsed = [];
  const seen = new Set();
  for (const item of raw) {
    let topic;
    let name = '';
    let type = 'thermo';
    if (typeof item === 'string') topic = item;
    else if (item && typeof item === 'object') {
      topic = item.topic;
      if (item.name != null) name = item.name;
      if (item.type != null) type = item.type;
    }
    topic = String(topic == null ? '' : topic).trim();
    if (topic === '') continue;
    if (!isValidMqttTopic(topic)) return { error: topic };
    if (seen.has(topic)) continue;
    seen.add(topic);
    parsed.push({
      topic,
      name: String(name == null ? '' : name).trim().slice(0, 64),
      type: (String(type == null ? '' : type).trim() || 'thermo').slice(0, 32),
    });
  }
  return parsed;
}

/** 单条连接的状态（status.connections 里按 id 匹配）。 */
function stFor(id) {
  return mqttClient.status().connections.find((c) => c.id === id);
}

function connToJson(row) {
  const st = stFor(row.id);
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    password_set: !!row.password,   // 不回传明文密码
    enabled: row.enabled,
    topics: db.latestNodesByTopic(row.user_id, row.id, row.topics),  // 订阅主题列表 + 每主题最新节点数据（数据/时间/状态）
    connected: st ? st.connected : false,
    last_error: st ? st.lastError : null,
  };
}

function getConnOr404(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(404).json({ detail: '连接不存在' });
    return null;
  }
  const row = db.getMqttConnection(id);
  if (!row || row.user_id !== req.user.id) {
    res.status(404).json({ detail: '连接不存在' });
    return null;
  }
  return row;
}

router.get('/', (req, res) => {
  res.json({ connections: db.listUserMqttConnections(req.user.id).map(connToJson) });
});

router.post('/', (req, res) => {
  const body = req.body || {};
  const name = String(body.name == null ? '' : body.name).trim();
  if (!name) return res.status(400).json({ detail: '连接名不能为空' });
  const host = String(body.host == null ? '' : body.host).trim();
  if (!host) return res.status(400).json({ detail: '服务器地址不能为空' });
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ detail: '端口需为 1-65535 的整数' });
  }
  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const topics = parseTopics(body.topics === undefined ? [] : body.topics);
  if (topics.error) return res.status(400).json({ detail: `MQTT 主题不合法：${topics.error}` });
  const enabled = body.enabled === undefined ? true : !!body.enabled;

  const row = db.insertMqttConnection({ userId: req.user.id, name, host, port, username, password, topics, enabled });
  db.syncTopicPanels(row.id, topics);
  mqttClient.connect(row.id);
  res.status(201).json(connToJson(row));
});

router.put('/:id', (req, res) => {
  const row = getConnOr404(req, res);
  if (!row) return;
  const body = req.body || {};

  const fields = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return res.status(400).json({ detail: '连接名不能为空' });
    fields.name = name;
  }
  if (body.host !== undefined) {
    const host = String(body.host).trim();
    if (!host) return res.status(400).json({ detail: '服务器地址不能为空' });
    fields.host = host;
  }
  if (body.port !== undefined) {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ detail: '端口需为 1-65535 的整数' });
    }
    fields.port = port;
  }
  if (body.username !== undefined) fields.username = typeof body.username === 'string' ? body.username : '';

  // 密码语义：clear_password=true 清除；password 非空则设置；否则保持不变
  if (body.clear_password === true) fields.password = '';
  else if (typeof body.password === 'string' && body.password) fields.password = body.password;

  let topics;
  if (body.topics !== undefined) {
    topics = parseTopics(body.topics);
    if (topics.error) return res.status(400).json({ detail: `MQTT 主题不合法：${topics.error}` });
    fields.topics = topics;
  }
  if (body.enabled !== undefined) fields.enabled = !!body.enabled;

  if (!Object.keys(fields).length) return res.status(400).json({ detail: '没有可更新的字段' });

  const updated = db.updateMqttConnection(row.id, fields);
  if (body.topics !== undefined) db.syncTopicPanels(updated.id, topics);
  // 只改主题：对在线连接做增量订阅（不重连）；连接级参数变化才整体重连
  if (body.topics !== undefined && Object.keys(fields).length === 1) {
    mqttClient.syncSubscriptions(updated.id);
  } else {
    mqttClient.reconnectConnection(updated.id);
  }
  res.json(connToJson(updated));
});

router.delete('/:id', (req, res) => {
  const row = getConnOr404(req, res);
  if (!row) return;
  db.deleteTopicPanelsForConnection(row.id);
  db.deleteMqttConnection(row.id);
  mqttClient.stopConnection(row.id);
  res.json({ ok: true });
});

module.exports = router;
