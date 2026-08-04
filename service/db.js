/* SQLite 数据访问层（better-sqlite3，同步 API）。
 * MQTT 消息量很小（每节点约 5 分钟一条），直接同步写库即可，无需独立写线程。
 * 节点用 (gateway_id, device_id) 复合身份：不同网关里可以有相同 device_id。 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

let db = null;

// 主页面虚拟舞台尺寸（像素）。面板位置/大小以该坐标系保存，与浏览器窗口大小无关。
// 注意：前端 public/app.js 中的 STAGE_W/STAGE_H 需与此保持一致。
const STAGE_W = 2560;
const STAGE_H = 1440;

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

CREATE TABLE IF NOT EXISTS panels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL DEFAULT '未命名面板',
    locked     INTEGER NOT NULL DEFAULT 0,      -- 1=锁定：禁止改名/删除/增删小面板
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topic_panels (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    panel_id      INTEGER NOT NULL,             -- 所属面板（容器，见 panels 表）
    connection_id INTEGER,                      -- 绑定节点的来源连接（可为空：未绑定主题的占位）
    topic         TEXT,                         -- 绑定节点的订阅主题（可为空）
    name          TEXT    NOT NULL DEFAULT '',  -- 小面板标题（节点名字）
    type          TEXT    NOT NULL DEFAULT 'thermo',  -- 面板类型：thermo=温湿度, switch=开关(待支持)
    x             REAL    NOT NULL DEFAULT 10,
    y             REAL    NOT NULL DEFAULT 10,
    w             REAL    NOT NULL DEFAULT 240,
    h             REAL    NOT NULL DEFAULT 200,
    temperature   REAL,
    humidity      INTEGER,
    battery       REAL,
    rssi          INTEGER,
    last_seen     TEXT,
    UNIQUE (panel_id, connection_id, topic)
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

/** 面板布局单位迁移：百分比 → 像素（2560×1440 虚拟舞台）。一次性，由 layout_px 标记幂等。 */
function migratePanelLayoutToPx() {
  const done = db.prepare("SELECT 1 FROM settings WHERE key = 'layout_px'").get();
  if (done) return;
  const rows = db.prepare('SELECT id, x, y, w, h FROM topic_panels').all();
  const upd = db.prepare('UPDATE topic_panels SET x = ?, y = ?, w = ?, h = ? WHERE id = ?');
  for (const p of rows) {
    upd.run(
      Math.round((p.x / 100) * STAGE_W),
      Math.round((p.y / 100) * STAGE_H),
      Math.round((p.w / 100) * STAGE_W),
      Math.round((p.h / 100) * STAGE_H),
      p.id
    );
  }
  setSetting('layout_px', '1');
  console.log(`面板布局已迁移到像素坐标（${STAGE_W}×${STAGE_H}），共 ${rows.length} 个面板`);
}

/** topic_panels 支持空白面板：connection_id/topic 改为可空（SQLite 的 UNIQUE 把 NULL 视为互异，
 * 因此 (NULL, NULL) 的空白面板可有多张，订阅主题面板的 (connection_id, topic) 唯一约束不受影响）。
 * 一次性，由 topic_panels_nullable 标记幂等。 */
function migrateTopicPanelsNullable() {
  const done = db.prepare("SELECT 1 FROM settings WHERE key = 'topic_panels_nullable'").get();
  if (done) return;
  const cols = db.prepare('PRAGMA table_info(topic_panels)').all();
  const conn = cols.find((c) => c.name === 'connection_id');
  const topic = cols.find((c) => c.name === 'topic');
  if (conn && conn.notnull === 0 && topic && topic.notnull === 0) {
    setSetting('topic_panels_nullable', '1');
    return;
  }
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE topic_panels RENAME TO topic_panels_legacy');
    db.exec(`
      CREATE TABLE topic_panels (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id INTEGER,                      -- 所属 MQTT 连接（可空：空白面板无来源连接）
        topic         TEXT,                         -- 主题字符串（可含 #/+ 通配符；可空：空白面板无主题）
        name          TEXT    NOT NULL DEFAULT '',  -- 节点名字（主面板标题）
        type          TEXT    NOT NULL DEFAULT 'thermo',  -- 面板类型：thermo=温湿度, switch=开关(待支持)
        x             REAL    NOT NULL DEFAULT 150, -- 像素坐标（2560×1440 虚拟舞台）
        y             REAL    NOT NULL DEFAULT 110,
        w             REAL    NOT NULL DEFAULT 480,
        h             REAL    NOT NULL DEFAULT 300,
        temperature   REAL,
        humidity      INTEGER,
        battery       REAL,
        rssi          INTEGER,
        last_seen     TEXT,
        UNIQUE (connection_id, topic)
      )
    `);
    db.exec(
      `INSERT INTO topic_panels (id, connection_id, topic, name, type, x, y, w, h, temperature, humidity, battery, rssi, last_seen)
       SELECT id, connection_id, topic, name, type, x, y, w, h, temperature, humidity, battery, rssi, last_seen
       FROM topic_panels_legacy`
    );
    db.exec('DROP TABLE topic_panels_legacy');
    db.exec('COMMIT');
    setSetting('topic_panels_nullable', '1');
    console.log('topic_panels 已迁移为可空 connection/topic（支持空白面板）');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 面板模型升级：新增 panels 容器表，topic_panels 改为「节点小面板」并归入某个面板。
 * 旧库迁移：已有订阅小面板全部放入「默认面板」；上一版的空白面板（connection_id/topic 为空）
 * 转成面板容器。一次性，由 panels_containers_v1 标记幂等。 */
function migratePanelContainers() {
  const done = db.prepare("SELECT 1 FROM settings WHERE key = 'panels_containers_v1'").get();
  if (done) return;
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS panels (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL DEFAULT '未命名面板',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    let def = db.prepare('SELECT id FROM panels ORDER BY id LIMIT 1').get();
    const defaultId = def ? def.id
                          : db.prepare('INSERT INTO panels (name) VALUES (?)').run('默认面板').lastInsertRowid;

    const cols = db.prepare('PRAGMA table_info(topic_panels)').all();
    const hasPanelId = cols.some((c) => c.name === 'panel_id');
    if (!hasPanelId) {
      // 旧表：空白 topic_panels 行 → 面板容器；真实订阅小面板 → 默认面板
      db.exec('ALTER TABLE topic_panels RENAME TO topic_panels_legacy');
      db.exec(`
        CREATE TABLE topic_panels (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          panel_id      INTEGER NOT NULL,
          connection_id INTEGER,
          topic         TEXT,
          name          TEXT    NOT NULL DEFAULT '',
          type          TEXT    NOT NULL DEFAULT 'thermo',
          x             REAL    NOT NULL DEFAULT 10,
          y             REAL    NOT NULL DEFAULT 10,
          w             REAL    NOT NULL DEFAULT 240,
          h             REAL    NOT NULL DEFAULT 200,
          temperature   REAL,
          humidity      INTEGER,
          battery       REAL,
          rssi          INTEGER,
          last_seen     TEXT,
          UNIQUE (panel_id, connection_id, topic)
        )
      `);
      const blanks = db.prepare('SELECT name FROM topic_panels_legacy WHERE connection_id IS NULL').all();
      const insPanel = db.prepare('INSERT INTO panels (name) VALUES (?)');
      for (const b of blanks) insPanel.run(b.name || '未命名面板');
      db.exec(
        `INSERT INTO topic_panels (id, panel_id, connection_id, topic, name, type, x, y, w, h, temperature, humidity, battery, rssi, last_seen)
         SELECT id, ${defaultId}, connection_id, topic, name, type, x, y, w, h, temperature, humidity, battery, rssi, last_seen
         FROM topic_panels_legacy WHERE connection_id IS NOT NULL`
      );
      db.exec('DROP TABLE topic_panels_legacy');
    } else {
      // 新库 / 部分迁移：小面板归入默认面板，空白行转容器
      db.exec(`UPDATE topic_panels SET panel_id = ${defaultId} WHERE panel_id IS NULL AND connection_id IS NOT NULL`);
      const blanks = db.prepare('SELECT id, name FROM topic_panels WHERE connection_id IS NULL').all();
      const insPanel = db.prepare('INSERT INTO panels (name) VALUES (?)');
      const del = db.prepare('DELETE FROM topic_panels WHERE id = ?');
      for (const b of blanks) { insPanel.run(b.name || '未命名面板'); del.run(b.id); }
    }
    db.exec('COMMIT');
    setSetting('panels_containers_v1', '1');
    console.log('已迁移到「面板容器 + 节点小面板」模型');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** panels 表增加 locked 列（面板锁定标记）。按列存在性幂等。 */
function migratePanelLocked() {
  const cols = db.prepare('PRAGMA table_info(panels)').all();
  if (!cols.some((c) => c.name === 'locked')) {
    db.exec('ALTER TABLE panels ADD COLUMN locked INTEGER NOT NULL DEFAULT 0');
    console.log('panels 表已增加 locked 列');
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
  migratePanelLayoutToPx();
  migrateTopicPanelsNullable();
  migratePanelContainers();
  migratePanelLocked();
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
// 面板容器 + 节点小面板
// panels 表 = 面板容器（主舞台一次显示一个）；topic_panels 表 = 节点小面板（归属某面板、绑定订阅主题）。
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

/** 保存连接主题后同步节点小面板：更新已有小面板的 name/type；主题被取消订阅 → 删除绑定该主题的小面板。
 * 不再自动创建小面板（由用户在主页面侧边栏手动添加）。 */
function syncTopicPanels(connectionId, topics) {
  const keepSet = new Set(topics.map((t) => t.topic));
  const upd = db.prepare('UPDATE topic_panels SET name = ?, type = ? WHERE connection_id = ? AND topic = ?');
  for (const t of topics) upd.run(t.name, t.type, connectionId, t.topic);
  const rows = db.prepare('SELECT id, topic FROM topic_panels WHERE connection_id = ?').all(connectionId);
  const del = db.prepare('DELETE FROM topic_panels WHERE id = ?');
  for (const r of rows) {
    if (!keepSet.has(r.topic)) del.run(r.id);
  }
}

/** 删除连接时清理其绑定主题的小面板。 */
function deleteTopicPanelsForConnection(connectionId) {
  return db.prepare('DELETE FROM topic_panels WHERE connection_id = ?').run(connectionId);
}

/** 一条消息按主题通配符路由到该连接下所有命中节点小面板，更新其最新数据。 */
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

/** 全部面板容器。 */
function listPanels() {
  return db.prepare('SELECT id, name, locked FROM panels ORDER BY id').all();
}

function getPanel(id) {
  return db.prepare('SELECT * FROM panels WHERE id = ?').get(id);
}

function createPanel(name) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM panels').get().n;
  const info = db.prepare('INSERT INTO panels (name, locked) VALUES (?, 0)')
    .run((name && String(name).trim()) || `新面板 ${count + 1}`);
  return getPanel(info.lastInsertRowid);
}

/** 部分更新面板：只写传入的字段（name 改名 / locked 锁定）。 */
function updatePanel(id, { name, locked } = {}) {
  const sets = [];
  const params = { id };
  if (name !== undefined) { sets.push('name = @name'); params.name = String(name).trim().slice(0, 64); }
  if (locked !== undefined) { sets.push('locked = @locked'); params.locked = locked ? 1 : 0; }
  if (!sets.length) return getPanel(id);
  db.prepare(`UPDATE panels SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getPanel(id);
}

/** 删除面板容器及其内全部节点小面板。 */
function deletePanel(id) {
  db.prepare('DELETE FROM topic_panels WHERE panel_id = ?').run(id);
  return db.prepare('DELETE FROM panels WHERE id = ?').run(id);
}

/** 全部节点小面板（主页面数据源）：只列出已启用连接绑定的。 */
function listWidgets() {
  const rows = db.prepare(
    `SELECT p.* FROM topic_panels p
     LEFT JOIN mqtt_connections c ON c.id = p.connection_id
     WHERE p.connection_id IS NULL OR c.enabled = 1
     ORDER BY p.panel_id, p.id`
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

function getWidget(id) {
  return db.prepare('SELECT * FROM topic_panels WHERE id = ?').get(id);
}

function updateWidgetLayout(id, x, y, w, h) {
  db.prepare('UPDATE topic_panels SET x = ?, y = ?, w = ?, h = ? WHERE id = ?').run(x, y, w, h, id);
  return getWidget(id);
}

/** 向某面板添加一个绑定订阅主题的节点小面板（同面板同主题去重）。 */
function createWidget(panelId, node) {
  const exist = db.prepare(
    'SELECT id FROM topic_panels WHERE panel_id = ? AND connection_id = ? AND topic = ?'
  ).get(panelId, node.connection_id, node.topic);
  if (exist) return getWidget(exist.id);
  const info = db.prepare(
    'INSERT INTO topic_panels (panel_id, connection_id, topic, name, type) VALUES (?, ?, ?, ?, ?)'
  ).run(panelId, node.connection_id, node.topic, node.name || '', node.type || 'thermo');
  return getWidget(info.lastInsertRowid);
}

function deleteWidget(id) {
  return db.prepare('DELETE FROM topic_panels WHERE id = ?').run(id);
}

/** 可添加的节点（订阅主题池）：所有已启用连接的订阅主题，供「添加节点」下拉使用。 */
function listAvailableNodes() {
  const nodes = [];
  for (const conn of listMqttConnections()) {
    if (!conn.enabled) continue;
    for (const t of conn.topics) {
      nodes.push({
        connection_id: conn.id,
        connection_name: conn.name,
        topic: t.topic,
        name: t.name || '',
        type: t.type || 'thermo',
      });
    }
  }
  return nodes;
}

module.exports = {
  init,
  STAGE_W,
  STAGE_H,
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
  createPanel,
  updatePanel,
  deletePanel,
  listWidgets,
  getWidget,
  updateWidgetLayout,
  createWidget,
  deleteWidget,
  listAvailableNodes,
};
