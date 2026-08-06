/* MQTT 客户端管理器（mqtt.js）：管理多条命名连接，每条连接订阅自己配置的 Topic 列表（支持通配符）。
 * 连接配置来自数据库 mqtt_connections 表（可在 Web 端增删改，每连接可独立启用/停用）。
 * 消息量很小，better-sqlite3 同步写库足够，无需额外队列。 */
const mqtt = require('mqtt');
const db = require('./db');

/** id -> { client, connected, lastError }；Map 保证按插入顺序遍历（与连接 id 顺序一致）。 */
const connections = new Map();

function validate(payload, topic, connectionId) {
  let obj;
  try {
    obj = JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  // 节点身份优先从 topic 解析：gateway_<网关id>/node_<节点id>/<设备类型>
  // 不匹配（旧格式 / 任意主题）时回退到 payload 的 id，gateway_id=0
  let gatewayId = 0;
  let deviceType = '';
  const m = /^gateway_(\d+)\/node_(\d+)\/([^/]+)$/.exec(String(topic || ''));
  if (m) {
    gatewayId = Number(m[1]);
    deviceType = m[3].slice(0, 64);
  }
  const id = m ? Number(m[2]) : Number(obj.id);
  if (!Number.isInteger(id) || id < 1 || id > 65535) return null;
  if (!Number.isInteger(gatewayId) || gatewayId < 0 || gatewayId > 99999999) return null;

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
    gateway_id: gatewayId,
    id,
    connection_id: connectionId ?? null,   // 来源连接：决定该节点显示在哪张连接卡片下
    device_type: deviceType,
    name: (name || 'Unnamed').slice(0, 64),
    temperature,
    humidity: humidity == null ? null : Math.trunc(humidity),
    battery,
    rssi: rssi == null ? null : Math.trunc(rssi),
    received_at: db.nowIso(),
  };
}

/** 共享消息处理：节点身份从主题/负载解析（与来自哪条连接无关），来源连接仅作记录。
 * 多用户：消息归属该连接的用户（rec.user_id），落库/面板路由按用户隔离。 */
function onMessage(topic, payload, connectionId, userId) {
  const rec = validate(payload, topic, connectionId);
  if (!rec) return;
  // 只监听订阅主题列表中的节点：消息主题须命中该连接任一订阅主题（支持通配符），否则忽略。
  // 连接级参数以库内最新配置为准（订阅列表即用户当前订阅的主题）。
  const conn = db.getMqttConnection(connectionId);
  if (!conn || !conn.enabled) return;
  const subscribed = (conn.topics || []).some((t) => db.topicMatches(t.topic, topic));
  if (!subscribed) return;
  rec.user_id = userId;
  try {
    db.upsertTelemetry(rec);
  } catch (err) {
    console.error('写入 telemetry 失败:', err);
  }
  // 路由到同连接下主题通配符命中的主面板
  try {
    db.routeMessageToPanels(rec, topic, connectionId);
  } catch (err) {
    console.error('路由主题面板失败:', err);
  }
}

/** 建立一条连接的客户端。连接缺失/已停用/未归属用户时 no-op；失败通过 'error' 事件上报，不抛异常。 */
function connect(id) {
  const row = db.getMqttConnection(id);
  if (!row || !row.enabled) return;
  if (!row.user_id) return;   // 未归属任何用户（防御：不建立，避免写入无主数据）
  const url = `mqtt://${row.host}:${row.port}`;
  const opts = { clientId: `thermo-service-${id}`, clean: true, reconnectPeriod: 10000 };
  if (row.username) {
    opts.username = row.username;
    opts.password = row.password;
  }
  let c;
  try {
    c = mqtt.connect(url, opts);
  } catch (err) {
    connections.set(id, { client: null, connected: false, lastError: (err && err.message) || String(err) });
    return;
  }
  const entry = { client: c, connected: false, lastError: null, topics: new Set() };
  connections.set(id, entry);
  // 连接被替换/删除后，迟到回调一律忽略（沿用单连接时代的 client !== c 防陈旧模式）
  const guard = () => connections.get(id) !== entry;

  c.on('connect', () => {
    if (guard()) return;
    entry.connected = true;
    entry.lastError = null;
    const subs = row.topics.map((t) => t.topic);
    entry.topics = new Set(subs);
    if (subs.length > 0) {
      c.subscribe(subs);
      console.log(`MQTT 已连接 [#${id} ${row.name}]: ${url} 订阅 ${subs.join(', ')}`);
    } else {
      console.log(`MQTT 已连接 [#${id} ${row.name}]: ${url} 主题列表为空，未订阅任何主题`);
    }
  });
  c.on('reconnect', () => {
    if (guard()) return;
    entry.connected = false;
  });
  c.on('close', () => {
    if (guard()) return;
    entry.connected = false;
    console.warn(`MQTT 连接断开 [#${id} ${row.name}]（自动重连中）`);
  });
  c.on('error', (err) => {
    if (guard()) return;
    entry.lastError = (err && err.message) || String(err);
    console.error(`MQTT 错误 [#${id} ${row.name}]:`, entry.lastError);
  });
  c.on('message', (t, p) => onMessage(t, p, id, row.user_id));
}

/** 启动时按当前配置建立所有已启用的连接。 */
function start() {
  for (const row of db.listMqttConnections()) connect(row.id);
}

/** 断开所有连接（服务关闭时调用）。 */
function stop() {
  for (const entry of connections.values()) {
    if (entry.client) entry.client.end(true);
  }
  connections.clear();
}

/** 断开并移除一条连接；删除连接时由路由调用。 */
function stopConnection(id) {
  const entry = connections.get(id);
  if (entry && entry.client) entry.client.end(true);
  connections.delete(id);
}

/** 连接配置已变化：断开旧连接并按最新配置重连（停用则保持断开）。 */
function reconnectConnection(id) {
  console.log(`MQTT 配置已更新 [#${id}]，重连中…`);
  stopConnection(id);
  connect(id);
}

/** 订阅列表已变化：对已连接的客户端做增量 SUBSCRIBE/UNSUBSCRIBE，不重连。
 * 连接未启用 / 无存活客户端时仅改库，重连后按最新列表自然生效。 */
function syncSubscriptions(id) {
  const row = db.getMqttConnection(id);
  const entry = connections.get(id);
  if (!row || !row.enabled || !entry || !entry.client || !entry.connected) return;
  const next = new Set(row.topics.map((t) => t.topic));
  const prev = entry.topics || new Set();
  const add = [...next].filter((t) => !prev.has(t));
  const del = [...prev].filter((t) => !next.has(t));
  if (add.length) entry.client.subscribe(add);
  if (del.length) entry.client.unsubscribe(del);
  entry.topics = next;
  if (add.length || del.length) {
    console.log(`MQTT 订阅已更新 [#${id} ${row.name}]: +${add.join(', ') || '—'} -${del.join(', ') || '—'}`);
  }
}

function status() {
  const list = [];
  let anyConnected = false;
  let firstError = null;
  for (const [id, entry] of connections) {
    const st = { id, connected: entry.connected, last_error: entry.lastError };
    if (entry.connected) anyConnected = true;
    if (firstError === null && entry.lastError) firstError = entry.lastError;
    list.push(st);
  }
  return { connected: anyConnected, lastError: firstError, connections: list };
}

module.exports = {
  start,
  stop,
  connect,
  stopConnection,
  reconnectConnection,
  syncSubscriptions,
  status,
};
