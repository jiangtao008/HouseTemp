/* SQLite 数据访问层（better-sqlite3，同步 API）。
 * MQTT 消息量很小（每节点约 5 分钟一条），直接同步写库即可，无需独立写线程。
 * 节点用 (gateway_id, device_id) 复合身份：不同网关里可以有相同 device_id。 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
    gateway_id      INTEGER NOT NULL,
    device_id       INTEGER NOT NULL,
    connection_id   INTEGER,            -- 最近一次上报该节点的 MQTT 连接 id（可空：连接已删 / 迁移旧数据）
    name            TEXT    NOT NULL DEFAULT 'Unnamed',
    display_name    TEXT,
    device_type     TEXT    NOT NULL DEFAULT '',
    subscribed      INTEGER NOT NULL DEFAULT 0,
    last_seen       TEXT,
    last_temperature REAL,
    last_humidity   INTEGER,
    last_battery    REAL,
    last_rssi       INTEGER,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (gateway_id, device_id)
);

CREATE TABLE IF NOT EXISTS telemetry (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    gateway_id  INTEGER NOT NULL,
    node_id     INTEGER NOT NULL,
    temperature REAL,
    humidity    INTEGER,
    battery     REAL,
    rssi        INTEGER,
    received_at TEXT NOT NULL,
    FOREIGN KEY (gateway_id, node_id) REFERENCES nodes(gateway_id, device_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_telemetry_gateway_node_time ON telemetry(gateway_id, node_id, received_at);

CREATE TABLE IF NOT EXISTS panel_layouts (
    gateway_id INTEGER NOT NULL,
    node_id    INTEGER NOT NULL,
    x          REAL NOT NULL DEFAULT 10,
    y          REAL NOT NULL DEFAULT 10,
    w          REAL NOT NULL DEFAULT 20,
    h          REAL NOT NULL DEFAULT 25,
    updated_at TEXT,
    PRIMARY KEY (gateway_id, node_id)
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS mqtt_connections (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    host       TEXT    NOT NULL,
    port       INTEGER NOT NULL,
    username   TEXT    NOT NULL DEFAULT '',
    password   TEXT    NOT NULL DEFAULT '',
    topics     TEXT    NOT NULL DEFAULT '[]',   -- JSON 数组（[{topic,name,type}]，主题可含 #/+ 通配符，用 JSON 存储）
    enabled    INTEGER NOT NULL DEFAULT 1,       -- 0/1 启用开关
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS topic_panels (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL,             -- 所属 MQTT 连接
    topic         TEXT    NOT NULL,             -- 主题字符串（可含 #/+ 通配符）
    name          TEXT    NOT NULL DEFAULT '',  -- 节点名字（主面板标题）
    type          TEXT    NOT NULL DEFAULT 'thermo',  -- 面板类型：thermo=温湿度, switch=开关(待支持)
    x             REAL    NOT NULL DEFAULT 10,
    y             REAL    NOT NULL DEFAULT 10,
    w             REAL    NOT NULL DEFAULT 20,
    h             REAL    NOT NULL DEFAULT 24,
    temperature   REAL,
    humidity      INTEGER,
    battery       REAL,
    rssi          INTEGER,
    last_seen     TEXT,
    UNIQUE (connection_id, topic)
);
`;

const DEFAULT_SETTINGS = { background: '', lock_all: '0' };

function nowIso() {
  return new Date().toISOString();
}

/** 旧库（nodes 只有 device_id 主键）迁移到复合身份；全新库无需迁移。 */
function migrateIfNeeded() {
  const hasTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'"
  ).all().length > 0;
  if (!hasTable) return;
  let cols = db.prepare('PRAGMA table_info(nodes)').all();

  if (!cols.some((c) => c.name === 'gateway_id')) {
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE nodes RENAME TO nodes_legacy');
      db.exec('ALTER TABLE telemetry RENAME TO telemetry_legacy');
      db.exec('ALTER TABLE panel_layouts RENAME TO panel_layouts_legacy');
      db.exec(SCHEMA); // 建新表（IF NOT EXISTS）
      db.exec(
        `INSERT INTO nodes (gateway_id, device_id, name, display_name, subscribed,
                            last_seen, last_temperature, last_humidity, last_battery, last_rssi, created_at)
         SELECT 0, device_id, name, display_name, subscribed,
                last_seen, last_temperature, last_humidity, last_battery, last_rssi, created_at
         FROM nodes_legacy`
      );
      db.exec(
        `INSERT INTO telemetry (gateway_id, node_id, temperature, humidity, battery, rssi, received_at)
         SELECT 0, node_id, temperature, humidity, battery, rssi, received_at FROM telemetry_legacy`
      );
      db.exec(
        `INSERT INTO panel_layouts (gateway_id, node_id, x, y, w, h, updated_at)
         SELECT 0, node_id, x, y, w, h, updated_at FROM panel_layouts_legacy`
      );
      db.exec('DROP TABLE nodes_legacy; DROP TABLE telemetry_legacy; DROP TABLE panel_layouts_legacy;');
      db.exec('COMMIT');
      console.log('数据库已迁移到 (gateway_id, device_id) 复合身份，旧数据归入 gateway_id=0');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // 补充节点来源连接字段：记录每个节点最近一次由哪条 MQTT 连接上报
  cols = db.prepare('PRAGMA table_info(nodes)').all();
  if (!cols.some((c) => c.name === 'connection_id')) {
    db.exec('ALTER TABLE nodes ADD COLUMN connection_id INTEGER');
  }
}

function init(cfg) {
  fs.mkdirSync(path.dirname(cfg.database.path), { recursive: true });
  db = new Database(cfg.database.path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrateIfNeeded();
  db.exec(SCHEMA);
  const seed = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) seed.run(k, v);
  migrateMqttConnections(cfg);
}

/** MQTT 连接初始化：旧版扁平 settings 键（mqtt_host 等）迁移成一条"默认连接"，全新库则用 config.json 初始化。
 * 幂等：表里已有连接或已打过 mqtt_seeded 标记（用户曾删光所有连接）时不再重建。 */
function migrateMqttConnections(cfg) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM mqtt_connections').get().n;
  if (count > 0) return;
  const seeded = db.prepare("SELECT 1 FROM settings WHERE key = 'mqtt_seeded'").get();
  if (seeded) return;

  const legacy = db.prepare("SELECT 1 FROM settings WHERE key = 'mqtt_host'").get();
  let name, host, port, username, password, topics;
  if (legacy) {
    const s = getSettings();
    name = '默认连接';
    host = s.mqtt_host || cfg.mqtt.host || '127.0.0.1';
    port = Number(s.mqtt_port) || cfg.mqtt.port || 1883;
    username = s.mqtt_username || '';
    password = s.mqtt_password || '';
    topics = safeParseTopics(s.mqtt_topics);
  } else {
    name = '默认连接';
    host = cfg.mqtt.host || '127.0.0.1';
    port = Number(cfg.mqtt.port) || 1883;
    username = cfg.mqtt.username || '';
    password = cfg.mqtt.password || '';
    topics = normalizeTopics(cfg.mqtt.topics);
  }

  db.exec('BEGIN');
  try {
    insertMqttConnection({ name, host, port, username, password, topics, enabled: true });
    if (legacy) {
      db.prepare(
        "DELETE FROM settings WHERE key IN ('mqtt_host','mqtt_port','mqtt_username','mqtt_password','mqtt_topics')"
      ).run();
    }
    setSetting('mqtt_seeded', '1');
    db.exec('COMMIT');
    console.log(legacy ? 'MQTT 旧配置已迁移到默认连接' : '已用 config.json 初始化默认 MQTT 连接');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 节点
// ---------------------------------------------------------------------------

function listNodes({ subscribedOnly = false, gatewayId } = {}) {
  const where = [];
  const params = {};
  if (subscribedOnly) where.push('subscribed = 1');
  if (gatewayId !== undefined) { where.push('gateway_id = @gateway_id'); params.gateway_id = gatewayId; }
  let sql = 'SELECT * FROM nodes';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY gateway_id, device_id';
  return db.prepare(sql).all(params);
}

function getNode(gatewayId, deviceId) {
  return db.prepare('SELECT * FROM nodes WHERE gateway_id = ? AND device_id = ?').get(gatewayId, deviceId);
}

/** 更新订阅状态和/或显示名。displayName 为 undefined 时不修改；null 表示清除覆盖。 */
function updateNode(gatewayId, deviceId, { subscribed, displayName } = {}) {
  const sets = [];
  const params = {};
  if (subscribed !== undefined) { sets.push('subscribed = @subscribed'); params.subscribed = subscribed ? 1 : 0; }
  if (displayName !== undefined) { sets.push('display_name = @display_name'); params.display_name = displayName; }
  if (!sets.length) return;
  params.gateway_id = gatewayId;
  params.device_id = deviceId;
  db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE gateway_id = @gateway_id AND device_id = @device_id`).run(params);
}

// ---------------------------------------------------------------------------
// 历史数据
// ---------------------------------------------------------------------------

function listTelemetry(gatewayId, deviceId, limit = 100) {
  return db.prepare(
    'SELECT temperature, humidity, battery, rssi, received_at' +
    ' FROM telemetry WHERE gateway_id = ? AND node_id = ? ORDER BY received_at DESC, id DESC LIMIT ?'
  ).all(gatewayId, deviceId, limit);
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
    'INSERT INTO nodes (gateway_id, device_id, connection_id, name, device_type, last_seen,' +
    ' last_temperature, last_humidity, last_battery, last_rssi)' +
    ' VALUES (@gateway_id, @id, @connection_id, @name, @device_type, @received_at, @temperature, @humidity, @battery, @rssi)' +
    ' ON CONFLICT(gateway_id, device_id) DO UPDATE SET' +
    ' name=excluded.name, device_type=excluded.device_type, connection_id=excluded.connection_id,' +
    ' last_seen=excluded.last_seen,' +
    ' last_temperature=excluded.last_temperature, last_humidity=excluded.last_humidity,' +
    ' last_battery=excluded.last_battery, last_rssi=excluded.last_rssi'
  ).run(rec);
  db.prepare(
    'INSERT INTO telemetry (gateway_id, node_id, temperature, humidity, battery, rssi, received_at)' +
    ' VALUES (@gateway_id, @id, @temperature, @humidity, @battery, @rssi, @received_at)'
  ).run(rec);
}

// ---------------------------------------------------------------------------
// 面板布局
// ---------------------------------------------------------------------------

function getLayouts() {
  return db.prepare('SELECT * FROM panel_layouts').all();
}

function getLayout(gatewayId, deviceId) {
  return db.prepare('SELECT * FROM panel_layouts WHERE gateway_id = ? AND node_id = ?').get(gatewayId, deviceId);
}

function upsertLayout(gatewayId, deviceId, x, y, w, h) {
  db.prepare(
    'INSERT INTO panel_layouts (gateway_id, node_id, x, y, w, h, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)' +
    ' ON CONFLICT(gateway_id, node_id) DO UPDATE SET x=excluded.x, y=excluded.y, w=excluded.w, h=excluded.h, updated_at=excluded.updated_at'
  ).run(gatewayId, deviceId, x, y, w, h, nowIso());
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
// MQTT 连接（Web 端可增删改，存 mqtt_connections 表）
// ---------------------------------------------------------------------------

/** 把主题数组归一化为 [{topic,name,type}]：兼容旧字符串数组与对象数组，topic 去空去重。 */
function normalizeTopics(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    let topic;
    let name = '';
    let type = 'thermo';
    if (typeof item === 'string') topic = item;
    else if (item && typeof item === 'object') {
      topic = item.topic;
      if (item.name != null) name = item.name;
      if (item.type != null) type = item.type;
    }
    if (typeof topic !== 'string') continue;
    topic = topic.trim();
    if (!topic || seen.has(topic)) continue;
    seen.add(topic);
    out.push({
      topic,
      name: (typeof name === 'string' ? name : String(name)).trim().slice(0, 64),
      type: ((typeof type === 'string' ? type : String(type)).trim() || 'thermo').slice(0, 32),
    });
  }
  return out;
}

/** 解析 topics 的 JSON 字符串，容错地返回归一化后的主题数组。 */
function safeParseTopics(raw) {
  let arr = [];
  try { arr = JSON.parse(raw); } catch (e) { arr = []; }
  return normalizeTopics(arr);
}

function rowToConn(r) {
  return { ...r, topics: safeParseTopics(r.topics), enabled: !!r.enabled };
}

function listMqttConnections() {
  return db.prepare('SELECT * FROM mqtt_connections ORDER BY id').all().map(rowToConn);
}

function getMqttConnection(id) {
  const row = db.prepare('SELECT * FROM mqtt_connections WHERE id = ?').get(id);
  return row ? rowToConn(row) : undefined;
}

function insertMqttConnection({ name, host, port, username = '', password = '', topics = [], enabled = true }) {
  const now = nowIso();
  const info = db.prepare(
    'INSERT INTO mqtt_connections (name, host, port, username, password, topics, enabled, created_at, updated_at)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(name, host, port, username, password, JSON.stringify(topics), enabled ? 1 : 0, now, now);
  return getMqttConnection(info.lastInsertRowid);
}

/** 动态部分更新：只写传入的字段（undefined 不修改），topics/enabled 做类型转换。 */
function updateMqttConnection(id, fields) {
  const sets = [];
  const params = { id };
  for (const key of ['name', 'host', 'port', 'username', 'password', 'enabled', 'topics']) {
    if (fields[key] === undefined) continue;
    let value = fields[key];
    if (key === 'topics') value = JSON.stringify(value);
    else if (key === 'enabled') value = value ? 1 : 0;
    sets.push(`${key} = @${key}`);
    params[key] = value;
  }
  if (!sets.length) return getMqttConnection(id);
  sets.push('updated_at = @updated_at');
  params.updated_at = nowIso();
  db.prepare(`UPDATE mqtt_connections SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getMqttConnection(id);
}

function deleteMqttConnection(id) {
  // 该连接的节点来源连接作废，归入「未关联」分组，避免悬挂引用
  db.prepare('UPDATE nodes SET connection_id = NULL WHERE connection_id = ?').run(id);
  return db.prepare('DELETE FROM mqtt_connections WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// 主题面板（订阅主题 → 主页面节点面板）
// ---------------------------------------------------------------------------

/** MQTT 通配符匹配：pattern 支持 +（单层）与 #（剩余所有层，# 匹配零层亦可）。 */
function topicMatches(pattern, topic) {
  const p = String(pattern).split('/');
  const t = String(topic || '').split('/');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return true;
    if (t[i] === undefined) return false;
    if (p[i] === '+') continue;
    if (p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}

/** 保存连接主题后同步面板：新增缺失、更新 name/type、删除被移除的主题。只写配置与布局，不碰已有数据列。 */
function syncTopicPanels(connectionId, topics) {
  const existing = db.prepare('SELECT topic FROM topic_panels WHERE connection_id = ?').all(connectionId);
  const existSet = new Set(existing.map((r) => r.topic));
  const keepSet = new Set(topics.map((t) => t.topic));
  const base = db.prepare('SELECT COUNT(*) AS n FROM topic_panels').get().n;
  const insert = db.prepare(
    'INSERT INTO topic_panels (connection_id, topic, name, type, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?, ?, ?)' +
    ' ON CONFLICT(connection_id, topic) DO UPDATE SET name = excluded.name, type = excluded.type'
  );
  const update = db.prepare('UPDATE topic_panels SET name = ?, type = ? WHERE connection_id = ? AND topic = ?');
  let k = 0;
  for (const t of topics) {
    if (!existSet.has(t.topic)) {
      const col = (base + k) % 4, row = Math.floor((base + k) / 4);
      insert.run(connectionId, t.topic, t.name, t.type, 6 + col * 24, 8 + row * 28, 20, 24);
      k++;
    } else {
      update.run(t.name, t.type, connectionId, t.topic);
    }
  }
  for (const topic of existSet) {
    if (!keepSet.has(topic)) {
      db.prepare('DELETE FROM topic_panels WHERE connection_id = ? AND topic = ?').run(connectionId, topic);
    }
  }
}

/** 删除连接时清理其主题面板。 */
function deleteTopicPanelsForConnection(connectionId) {
  return db.prepare('DELETE FROM topic_panels WHERE connection_id = ?').run(connectionId);
}

/** 一条消息按主题通配符路由到该连接下所有命中面板，更新其最新数据。 */
function routeMessageToPanels(rec, topic, connectionId) {
  const panels = db.prepare('SELECT id, topic FROM topic_panels WHERE connection_id = ?').all(connectionId);
  if (!panels.length) return;
  const stmt = db.prepare(
    'UPDATE topic_panels SET temperature = ?, humidity = ?, battery = ?, rssi = ?, last_seen = ? WHERE id = ?'
  );
  for (const p of panels) {
    if (topicMatches(p.topic, topic)) {
      stmt.run(rec.temperature, rec.humidity, rec.battery, rec.rssi, rec.received_at, p.id);
    }
  }
}

const PANEL_STALE_AFTER_MS = 10 * 60 * 1000; // 超过 10 分钟未上报视为离线

/** 已启用连接下的全部主题面板（主页面数据源）。 */
function listPanels() {
  const rows = db.prepare(
    `SELECT p.* FROM topic_panels p
     JOIN mqtt_connections c ON c.id = p.connection_id
     WHERE c.enabled = 1 ORDER BY p.id`
  ).all();
  return rows.map((r) => {
    let stale = false;
    if (r.last_seen) {
      const ts = new Date(r.last_seen).getTime();
      stale = !Number.isNaN(ts) && Date.now() - ts > PANEL_STALE_AFTER_MS;
    }
    return { ...r, stale };
  });
}

function getPanel(id) {
  return db.prepare('SELECT * FROM topic_panels WHERE id = ?').get(id);
}

function updatePanelLayout(id, x, y, w, h) {
  db.prepare('UPDATE topic_panels SET x = ?, y = ?, w = ?, h = ? WHERE id = ?').run(x, y, w, h, id);
  return getPanel(id);
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
  listMqttConnections,
  getMqttConnection,
  insertMqttConnection,
  updateMqttConnection,
  deleteMqttConnection,
  syncTopicPanels,
  deleteTopicPanelsForConnection,
  routeMessageToPanels,
  listPanels,
  getPanel,
  updatePanelLayout,
};
