/* SQLite 数据访问层（better-sqlite3，同步 API）。
 * MQTT 消息量很小（每节点约 5 分钟一条），直接同步写库即可，无需独立写线程。 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
    device_id       INTEGER PRIMARY KEY,
    name            TEXT    NOT NULL DEFAULT 'Unnamed',
    display_name    TEXT,
    subscribed      INTEGER NOT NULL DEFAULT 0,
    last_seen       TEXT,
    last_temperature REAL,
    last_humidity   INTEGER,
    last_battery    REAL,
    last_rssi       INTEGER,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS telemetry (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id     INTEGER NOT NULL,
    temperature REAL,
    humidity    INTEGER,
    battery     REAL,
    rssi        INTEGER,
    received_at TEXT NOT NULL,
    FOREIGN KEY (node_id) REFERENCES nodes(device_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_telemetry_node_time ON telemetry(node_id, received_at);

CREATE TABLE IF NOT EXISTS panel_layouts (
    node_id    INTEGER PRIMARY KEY,
    x          REAL NOT NULL DEFAULT 10,
    y          REAL NOT NULL DEFAULT 10,
    w          REAL NOT NULL DEFAULT 20,
    h          REAL NOT NULL DEFAULT 25,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);
`;

const DEFAULT_SETTINGS = { background: '', lock_all: '0' };

function nowIso() {
  return new Date().toISOString();
}

function init(cfg) {
  fs.mkdirSync(path.dirname(cfg.database.path), { recursive: true });
  db = new Database(cfg.database.path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  const seed = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) seed.run(k, v);
  // MQTT 初始配置取 config.json 值；INSERT OR IGNORE 保证已存在的值（如 Web 端改过）优先
  const mqttSeed = {
    mqtt_host: cfg.mqtt.host,
    mqtt_port: String(cfg.mqtt.port),
    mqtt_username: cfg.mqtt.username || '',
    mqtt_password: cfg.mqtt.password || '',
  };
  for (const [k, v] of Object.entries(mqttSeed)) seed.run(k, v);
}

// ---------------------------------------------------------------------------
// 节点
// ---------------------------------------------------------------------------

function listNodes({ subscribedOnly = false } = {}) {
  let sql = 'SELECT * FROM nodes';
  if (subscribedOnly) sql += ' WHERE subscribed = 1';
  sql += ' ORDER BY device_id';
  return db.prepare(sql).all();
}

function getNode(deviceId) {
  return db.prepare('SELECT * FROM nodes WHERE device_id = ?').get(deviceId);
}

/** 更新订阅状态和/或显示名。displayName 为 undefined 时不修改；null 表示清除覆盖。 */
function updateNode(deviceId, { subscribed, displayName } = {}) {
  const sets = [];
  const params = {};
  if (subscribed !== undefined) { sets.push('subscribed = @subscribed'); params.subscribed = subscribed ? 1 : 0; }
  if (displayName !== undefined) { sets.push('display_name = @display_name'); params.display_name = displayName; }
  if (!sets.length) return;
  params.device_id = deviceId;
  db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE device_id = @device_id`).run(params);
}

// ---------------------------------------------------------------------------
// 历史数据
// ---------------------------------------------------------------------------

function listTelemetry(deviceId, limit = 100) {
  return db.prepare(
    'SELECT temperature, humidity, battery, rssi, received_at' +
    ' FROM telemetry WHERE node_id = ? ORDER BY received_at DESC, id DESC LIMIT ?'
  ).all(deviceId, limit);
}

/** 删除超过保留天数的历史（cutoff 为 ISO 字符串，与存储格式一致可正确比较）。 */
function cleanupTelemetry(cutoffIso) {
  return db.prepare('DELETE FROM telemetry WHERE received_at < ?').run(cutoffIso);
}

// ---------------------------------------------------------------------------
// MQTT 落库
// ---------------------------------------------------------------------------

function upsertTelemetry(rec) {
  db.prepare(
    'INSERT INTO nodes (device_id, name, last_seen, last_temperature, last_humidity, last_battery, last_rssi)' +
    ' VALUES (@id, @name, @received_at, @temperature, @humidity, @battery, @rssi)' +
    ' ON CONFLICT(device_id) DO UPDATE SET' +
    ' name=excluded.name, last_seen=excluded.last_seen,' +
    ' last_temperature=excluded.last_temperature, last_humidity=excluded.last_humidity,' +
    ' last_battery=excluded.last_battery, last_rssi=excluded.last_rssi'
  ).run(rec);
  db.prepare(
    'INSERT INTO telemetry (node_id, temperature, humidity, battery, rssi, received_at)' +
    ' VALUES (@id, @temperature, @humidity, @battery, @rssi, @received_at)'
  ).run(rec);
}

// ---------------------------------------------------------------------------
// 面板布局
// ---------------------------------------------------------------------------

function getLayouts() {
  return db.prepare('SELECT * FROM panel_layouts').all();
}

function getLayout(deviceId) {
  return db.prepare('SELECT * FROM panel_layouts WHERE node_id = ?').get(deviceId);
}

function upsertLayout(deviceId, x, y, w, h) {
  db.prepare(
    'INSERT INTO panel_layouts (node_id, x, y, w, h, updated_at) VALUES (?, ?, ?, ?, ?, ?)' +
    ' ON CONFLICT(node_id) DO UPDATE SET x=excluded.x, y=excluded.y, w=excluded.w, h=excluded.h, updated_at=excluded.updated_at'
  ).run(deviceId, x, y, w, h, nowIso());
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  return obj;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?)' +
    ' ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, value);
}

// ---------------------------------------------------------------------------
// MQTT 服务配置（Web 端可改，存 settings 表）
// ---------------------------------------------------------------------------

/** 读取 MQTT 连接参数：settings 表优先，缺失时回退本地默认。 */
function getMqttSettings() {
  const s = getSettings();
  return {
    host: s.mqtt_host || '127.0.0.1',
    port: Number(s.mqtt_port) || 1883,
    username: s.mqtt_username || '',
    password: s.mqtt_password || '',
  };
}

/** 保存 MQTT 配置；字段缺省时不修改该字段。 */
function saveMqttSettings({ host, port, username, password } = {}) {
  if (host !== undefined) setSetting('mqtt_host', host);
  if (port !== undefined) setSetting('mqtt_port', String(port));
  if (username !== undefined) setSetting('mqtt_username', username);
  if (password !== undefined) setSetting('mqtt_password', password);
}

module.exports = {
  init,
  nowIso,
  listNodes,
  getNode,
  updateNode,
  listTelemetry,
  cleanupTelemetry,
  upsertTelemetry,
  getLayouts,
  getLayout,
  upsertLayout,
  getSettings,
  setSetting,
  getMqttSettings,
  saveMqttSettings,
};
