/* MQTT 客户端（mqtt.js）：订阅 iot/device/+/sensor，解析校验后直接落库。
 * 连接参数来自数据库 settings 表（可在 Web 端修改），topic 来自 config.json。
 * 消息量很小，better-sqlite3 同步写库足够，无需额外队列。 */
const mqtt = require('mqtt');
const config = require('./config');
const db = require('./db');

const state = { connected: false, lastError: null };
let client = null;

function validate(payload) {
  let obj;
  try {
    obj = JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const id = Number(obj.id);
  if (!Number.isInteger(id) || id < 1 || id > 65535) return null;

  const num = (key, lo, hi) => {
    if (obj[key] == null) return null;
    const v = Number(obj[key]);
    if (Number.isNaN(v)) return null;
    if (lo != null && v < lo) return null;
    if (hi != null && v > hi) return null;
    return v;
  };

  const temperature = num('temperature', -50, 100);
  const humidity = num('humidity', 0, 100);
  const battery = num('battery', 0, 20);
  const rssi = num('rssi', -200, 20);

  let name = obj.name;
  if (name != null && typeof name !== 'string') name = String(name);

  return {
    id,
    name: (name || 'Unnamed').slice(0, 64),
    temperature,
    humidity: humidity == null ? null : Math.trunc(humidity),
    battery,
    rssi: rssi == null ? null : Math.trunc(rssi),
    received_at: db.nowIso(),
  };
}

function buildOptions() {
  const m = db.getMqttSettings();
  const topic = config.load().mqtt.topic;
  const opts = { clientId: 'thermo-service', clean: true, reconnectPeriod: 10000 };
  if (m.username) {
    opts.username = m.username;
    opts.password = m.password;
  }
  return { host: m.host, port: m.port, url: `mqtt://${m.host}:${m.port}`, topic, opts };
}

function start() {
  const { url, topic, opts } = buildOptions();
  const c = mqtt.connect(url, opts);
  client = c;

  c.on('connect', () => {
    if (client !== c) return; // 旧连接回调，忽略
    state.connected = true;
    state.lastError = null;
    c.subscribe(topic);
    console.log(`MQTT 已连接: ${url} 订阅 ${topic}`);
  });
  c.on('reconnect', () => {
    if (client !== c) return;
    state.connected = false;
  });
  c.on('close', () => {
    if (client !== c) return;
    state.connected = false;
    console.warn('MQTT 连接断开（自动重连中）');
  });
  c.on('error', (err) => {
    if (client !== c) return;
    state.lastError = (err && err.message) || String(err);
    console.error('MQTT 错误:', state.lastError);
  });
  c.on('message', (_topic, payload) => {
    const rec = validate(payload);
    if (!rec) return;
    try {
      db.upsertTelemetry(rec);
    } catch (err) {
      console.error('写入 telemetry 失败:', err);
    }
  });

  return c;
}

function stop() {
  if (client) {
    client.end(true);
    client = null;
  }
  state.connected = false;
}

/** 连接参数可能已变化，断开旧连接并按最新配置重连。 */
function reconnect() {
  console.log('MQTT 配置已更新，重连中…');
  stop();
  start();
}

module.exports = {
  start,
  stop,
  reconnect,
  status: () => ({ connected: state.connected, lastError: state.lastError }),
};
