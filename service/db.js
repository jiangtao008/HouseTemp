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
    user_id         INTEGER NOT NULL,           -- 归属用户（多用户隔离）
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
    PRIMARY KEY (user_id, gateway_id, device_id)
);

CREATE TABLE IF NOT EXISTS telemetry (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    gateway_id  INTEGER NOT NULL,
    node_id     INTEGER NOT NULL,
    temperature REAL,
    humidity    INTEGER,
    battery     REAL,
    rssi        INTEGER,
    received_at TEXT NOT NULL,
    FOREIGN KEY (user_id, gateway_id, node_id) REFERENCES nodes(user_id, gateway_id, device_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_telemetry_user_gateway_node_time ON telemetry(user_id, gateway_id, node_id, received_at);

CREATE TABLE IF NOT EXISTS panel_layouts (
    user_id    INTEGER NOT NULL,
    gateway_id INTEGER NOT NULL,
    node_id    INTEGER NOT NULL,
    x          REAL NOT NULL DEFAULT 10,
    y          REAL NOT NULL DEFAULT 10,
    w          REAL NOT NULL DEFAULT 20,
    h          REAL NOT NULL DEFAULT 25,
    updated_at TEXT,
    PRIMARY KEY (user_id, gateway_id, node_id)
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,   -- 用户名不区分大小写唯一
    password_hash TEXT    NOT NULL,                          -- scrypt 哈希，存 salt:hash
    role          TEXT    NOT NULL DEFAULT 'user',           -- 'admin' | 'user'
    avatar        TEXT,                                      -- 头像图片 URL（/uploads/xxx；空=显示用户名首字符）
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    token        TEXT PRIMARY KEY,            -- 登录 token（长期有效，退出/删用户时删除）
    user_id      INTEGER NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL,
    key     TEXT    NOT NULL,
    value   TEXT,
    PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS mqtt_connections (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
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
    user_id    INTEGER NOT NULL,
    name       TEXT    NOT NULL DEFAULT '未命名面板',
    locked     INTEGER NOT NULL DEFAULT 0,      -- 1=锁定：禁止改名/删除/增删小面板
    grid_cols  INTEGER NOT NULL DEFAULT 2,      -- 移动端宫格列数（手机视图每面板可配）
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topic_panels (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
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
    show_temp     INTEGER NOT NULL DEFAULT 1,  -- 显示温度曲线（图表设置）
    show_hum      INTEGER NOT NULL DEFAULT 1,  -- 显示湿度曲线
    show_bat      INTEGER NOT NULL DEFAULT 1,  -- 显示电量曲线
    chart_range   TEXT    NOT NULL DEFAULT '1d', -- 曲线时间范围：1h/6h/1d/3d/7d/15d/1M/3M/6M/1Y
    chart_layout  TEXT    NOT NULL DEFAULT 'v', -- 曲线布局：v=垂直, h=水平
    grid_order    INTEGER NOT NULL DEFAULT 0,  -- 移动端宫格顺序（手机视图内排序，与桌面 2560×1440 布局独立）
    UNIQUE (panel_id, connection_id, topic)
);
`;

const DEFAULT_SETTINGS = { background: '', lock_all: '0' };

function nowIso() {
  return new Date().toISOString();
}

/** 多用户迁移（幂等）：按"旧数据不迁移"决策——丢弃旧库全部节点/历史/面板/MQTT 连接/布局数据，
 * 重建带 user_id 的新 schema；全新库（无旧表）等价于直接建表。
 * 以 nodes 表是否已含 user_id 列判断（列存在性，不依赖 settings 表，兼容首次迁移前无 settings 表的情况）。
 * 须在 init() 最早执行，保证后续旧迁移均为 no-op。 */
function migrateUsersScope() {
  const cols = db.prepare('PRAGMA table_info(nodes)').all();
  if (cols.some((c) => c.name === 'user_id')) return;   // 已迁移
  db.exec('BEGIN');
  try {
    for (const t of ['topic_panels', 'panels', 'mqtt_connections', 'panel_layouts', 'telemetry', 'nodes']) {
      db.exec(`DROP TABLE IF EXISTS ${t}`);
    }
    db.exec(SCHEMA);   // 重建带 user_id 的新表
    setSetting('users_scope_v1', '1');
    // 新 schema 已是最终形态（panel_id/可空 connection/像素坐标等均已含），打上遗留迁移标记使其 no-op
    for (const k of ['layout_px', 'topic_panels_nullable', 'panels_containers_v1']) setSetting(k, '1');
    db.exec('COMMIT');
    console.log('已迁移到多用户模型：旧节点/面板/MQTT/历史数据已清空，用户配置从零开始');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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
  const panelCols = db.prepare('PRAGMA table_info(panels)').all();
  if (panelCols.some((c) => c.name === 'user_id')) {
    setSetting('panels_containers_v1', '1');   // 新 schema 已含 panel_id/user_id，无需旧迁移
    return;
  }
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

/** topic_panels 增加图表显示开关列（show_temp/show_hum/show_bat，默认开）。按列存在性幂等。 */
function migrateWidgetChartFlags() {
  const cols = db.prepare('PRAGMA table_info(topic_panels)').all();
  const add = [
    ['show_temp', '显示温度曲线'],
    ['show_hum', '显示湿度曲线'],
    ['show_bat', '显示电量曲线'],
  ];
  for (const [name, desc] of add) {
    if (!cols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE topic_panels ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 1`);
      console.log(`topic_panels 已增加 ${name} 列（${desc}）`);
    }
  }
}

/** topic_panels 增加图表时间范围列（chart_range，默认 1d）。按列存在性幂等。 */
function migrateWidgetChartRange() {
  const cols = db.prepare('PRAGMA table_info(topic_panels)').all();
  if (!cols.some((c) => c.name === 'chart_range')) {
    db.exec("ALTER TABLE topic_panels ADD COLUMN chart_range TEXT NOT NULL DEFAULT '1d'");
    console.log('topic_panels 已增加 chart_range 列（曲线时间范围，默认 1d）');
  }
}

/** topic_panels 增加图表布局列（chart_layout，默认 v=垂直）。按列存在性幂等。 */
function migrateWidgetChartLayout() {
  const cols = db.prepare('PRAGMA table_info(topic_panels)').all();
  if (!cols.some((c) => c.name === 'chart_layout')) {
    db.exec("ALTER TABLE topic_panels ADD COLUMN chart_layout TEXT NOT NULL DEFAULT 'v'");
    console.log('topic_panels 已增加 chart_layout 列（曲线布局，默认垂直）');
  }
}

/** 移动端宫格布局迁移：topic_panels 增加 grid_order（宫格顺序），panels 增加 grid_cols（每面板列数）。
 * 两套布局独立：桌面用 2560×1440 像素自由布局，移动端用宫格排序，互不影响。按列存在性幂等。 */
function migrateMobileGrid() {
  const cols = db.prepare('PRAGMA table_info(topic_panels)').all();
  if (!cols.some((c) => c.name === 'grid_order')) {
    db.exec('ALTER TABLE topic_panels ADD COLUMN grid_order INTEGER NOT NULL DEFAULT 0');
    // 回填：每面板内按 id 升序编号（0..n-1），保证迁移后顺序稳定
    db.exec(`UPDATE topic_panels SET grid_order = (
      SELECT COUNT(*) FROM topic_panels t2
      WHERE t2.user_id = topic_panels.user_id
        AND t2.panel_id = topic_panels.panel_id
        AND t2.id < topic_panels.id
    )`);
    console.log('topic_panels 已增加 grid_order 列（移动端宫格顺序）');
  }
  const pcols = db.prepare('PRAGMA table_info(panels)').all();
  if (!pcols.some((c) => c.name === 'grid_cols')) {
    db.exec('ALTER TABLE panels ADD COLUMN grid_cols INTEGER NOT NULL DEFAULT 2');
    console.log('panels 已增加 grid_cols 列（移动端每面板列数，默认 2）');
  }
}

/** users 表增加 avatar 列（头像 URL，空=用用户名首字符兜底）。按列存在性幂等。 */
function migrateUserAvatar() {
  const cols = db.prepare('PRAGMA table_info(users)').all();
  if (!cols.some((c) => c.name === 'avatar')) {
    db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
    console.log('users 表已增加 avatar 列（头像）');
  }
}

function init(cfg) {
  fs.mkdirSync(path.dirname(cfg.database.path), { recursive: true });
  db = new Database(cfg.database.path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrateUsersScope();   // 最先：丢弃旧数据并重建带 user_id 的 schema
  migrateIfNeeded();
  db.exec(SCHEMA);
  const seed = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) seed.run(k, v);
  migratePanelLayoutToPx();
  migrateTopicPanelsNullable();
  migratePanelContainers();
  migratePanelLocked();
  migrateWidgetChartFlags();
  migrateWidgetChartRange();
  migrateWidgetChartLayout();
  migrateMobileGrid();
  migrateUserAvatar();
}

// ---------------------------------------------------------------------------
// 用户 / 会话（多用户认证）
// ---------------------------------------------------------------------------

function createUser(username, passwordHash, role = 'user') {
  const info = db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, role, nowIso());
  return getUserById(info.lastInsertRowid);
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function listUsers() {
  return db.prepare('SELECT id, username, role, avatar, created_at FROM users ORDER BY id').all();
}

function setUserPassword(id, hash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  return getUserById(id);
}

function setUserAvatar(id, avatar) {
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, id);
  return getUserById(id);
}

function setUserRole(id, role) {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  return getUserById(id);
}

function countAdmins() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
}

/** 删除用户并显式级联清理其全部数据（FK 未强制开启，需手动删）。 */
function deleteUser(id) {
  db.prepare('DELETE FROM topic_panels WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM panels WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM nodes WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM telemetry WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM panel_layouts WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM mqtt_connections WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(id);
  return db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

function createSession(token, userId) {
  db.prepare('INSERT INTO sessions (token, user_id, last_used_at) VALUES (?, ?, ?)').run(token, userId, nowIso());
}

/** 会话 → 归属用户（JOIN users 取 username/role/avatar）。无有效会话返回 undefined。 */
function getSession(token) {
  return db.prepare(
    `SELECT s.token, s.user_id, u.username, u.role, u.avatar FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).get(token);
}

function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function touchSession(token) {
  db.prepare('UPDATE sessions SET last_used_at = ? WHERE token = ?').run(nowIso(), token);
}

function getUserSetting(userId, key) {
  const r = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
  return r ? r.value : undefined;
}

function setUserSetting(userId, key, value) {
  db.prepare(
    'INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)' +
    ' ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value'
  ).run(userId, key, value);
}

/** 新用户注册时按 config.json 的 mqtt 段初始化一条「默认连接」（host 为空则不建），保持开箱即用。 */
function seedDefaultConnection(userId, cfg) {
  const host = String((cfg && cfg.mqtt && cfg.mqtt.host) || '').trim();
  if (!host) return null;
  const conn = insertMqttConnection({
    userId,
    name: '默认连接',
    host,
    port: Number(cfg.mqtt.port) || 1883,
    username: cfg.mqtt.username || '',
    password: cfg.mqtt.password || '',
    topics: normalizeTopics(cfg.mqtt.topics),
    enabled: true,
  });
  syncTopicPanels(conn.id, conn.topics);
  return conn;
}

// ---------------------------------------------------------------------------
// 节点
// ---------------------------------------------------------------------------

function listNodes({ userId, subscribedOnly = false, gatewayId } = {}) {
  const where = ['user_id = @user_id'];
  const params = { user_id: userId };
  if (subscribedOnly) where.push('subscribed = 1');
  if (gatewayId !== undefined) { where.push('gateway_id = @gateway_id'); params.gateway_id = gatewayId; }
  let sql = 'SELECT * FROM nodes';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY gateway_id, device_id';
  return db.prepare(sql).all(params);
}

function getNode(userId, gatewayId, deviceId) {
  return db.prepare('SELECT * FROM nodes WHERE user_id = ? AND gateway_id = ? AND device_id = ?')
    .get(userId, gatewayId, deviceId);
}

/** 更新订阅状态和/或显示名。displayName 为 undefined 时不修改；null 表示清除覆盖。 */
function updateNode(userId, gatewayId, deviceId, { subscribed, displayName } = {}) {
  const sets = [];
  const params = {};
  if (subscribed !== undefined) { sets.push('subscribed = @subscribed'); params.subscribed = subscribed ? 1 : 0; }
  if (displayName !== undefined) { sets.push('display_name = @display_name'); params.display_name = displayName; }
  if (!sets.length) return;
  params.user_id = userId;
  params.gateway_id = gatewayId;
  params.device_id = deviceId;
  db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE user_id = @user_id AND gateway_id = @gateway_id AND device_id = @device_id`).run(params);
}

// ---------------------------------------------------------------------------
// 历史数据
// ---------------------------------------------------------------------------

function listTelemetry(userId, gatewayId, deviceId, limit = 100) {
  return db.prepare(
    'SELECT temperature, humidity, battery, rssi, received_at' +
    ' FROM telemetry WHERE user_id = ? AND gateway_id = ? AND node_id = ? ORDER BY received_at DESC, id DESC LIMIT ?'
  ).all(userId, gatewayId, deviceId, limit);
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
    'INSERT INTO nodes (user_id, gateway_id, device_id, connection_id, name, device_type, last_seen,' +
    ' last_temperature, last_humidity, last_battery, last_rssi)' +
    ' VALUES (@user_id, @gateway_id, @id, @connection_id, @name, @device_type, @received_at, @temperature, @humidity, @battery, @rssi)' +
    ' ON CONFLICT(user_id, gateway_id, device_id) DO UPDATE SET' +
    ' name=excluded.name, device_type=excluded.device_type, connection_id=excluded.connection_id,' +
    ' last_seen=excluded.last_seen,' +
    ' last_temperature=excluded.last_temperature, last_humidity=excluded.last_humidity,' +
    ' last_battery=excluded.last_battery, last_rssi=excluded.last_rssi'
  ).run(rec);
  db.prepare(
    'INSERT INTO telemetry (user_id, gateway_id, node_id, temperature, humidity, battery, rssi, received_at)' +
    ' VALUES (@user_id, @gateway_id, @id, @temperature, @humidity, @battery, @rssi, @received_at)'
  ).run(rec);
}

// ---------------------------------------------------------------------------
// 面板布局（遗留路由，按用户隔离保持一致）
// ---------------------------------------------------------------------------

function getLayouts(userId) {
  return db.prepare('SELECT * FROM panel_layouts WHERE user_id = ?').all(userId);
}

function getLayout(userId, gatewayId, deviceId) {
  return db.prepare('SELECT * FROM panel_layouts WHERE user_id = ? AND gateway_id = ? AND node_id = ?')
    .get(userId, gatewayId, deviceId);
}

function upsertLayout(userId, gatewayId, deviceId, x, y, w, h) {
  db.prepare(
    'INSERT INTO panel_layouts (user_id, gateway_id, node_id, x, y, w, h, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)' +
    ' ON CONFLICT(user_id, gateway_id, node_id) DO UPDATE SET x=excluded.x, y=excluded.y, w=excluded.w, h=excluded.h, updated_at=excluded.updated_at'
  ).run(userId, gatewayId, deviceId, x, y, w, h, nowIso());
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

function listUserMqttConnections(userId) {
  return db.prepare('SELECT * FROM mqtt_connections WHERE user_id = ? ORDER BY id').all(userId).map(rowToConn);
}

function insertMqttConnection({ userId, name, host, port, username = '', password = '', topics = [], enabled = true }) {
  const now = nowIso();
  const info = db.prepare(
    'INSERT INTO mqtt_connections (user_id, name, host, port, username, password, topics, enabled, created_at, updated_at)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, name, host, port, username, password, JSON.stringify(topics), enabled ? 1 : 0, now, now);
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

/** 一条消息按主题通配符路由到该连接下所有命中节点小面板，更新其最新数据。
 * 连接 id 全局唯一（天然按用户隔离），防御性再加 user_id 过滤。 */
function routeMessageToPanels(rec, topic, connectionId) {
  const panels = db.prepare('SELECT id, topic FROM topic_panels WHERE connection_id = ? AND user_id = ?')
    .all(connectionId, rec.user_id);
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

/** 全部面板容器（某用户）。 */
function listPanels(userId) {
  return db.prepare('SELECT id, name, locked, grid_cols FROM panels WHERE user_id = ? ORDER BY id').all(userId);
}

function getPanel(userId, id) {
  return db.prepare('SELECT * FROM panels WHERE user_id = ? AND id = ?').get(userId, id);
}

function createPanel(userId, name) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM panels WHERE user_id = ?').get(userId).n;
  const info = db.prepare('INSERT INTO panels (user_id, name, locked) VALUES (?, ?, 0)')
    .run(userId, (name && String(name).trim()) || `新面板 ${count + 1}`);
  return getPanel(userId, info.lastInsertRowid);
}

/** 部分更新面板：只写传入的字段（name 改名 / locked 锁定）。 */
function updatePanel(userId, id, { name, locked } = {}) {
  const sets = [];
  const params = { user_id: userId, id };
  if (name !== undefined) { sets.push('name = @name'); params.name = String(name).trim().slice(0, 64); }
  if (locked !== undefined) { sets.push('locked = @locked'); params.locked = locked ? 1 : 0; }
  if (!sets.length) return getPanel(userId, id);
  db.prepare(`UPDATE panels SET ${sets.join(', ')} WHERE user_id = @user_id AND id = @id`).run(params);
  return getPanel(userId, id);
}

/** 删除面板容器及其内全部节点小面板。 */
function deletePanel(userId, id) {
  db.prepare('DELETE FROM topic_panels WHERE user_id = ? AND panel_id = ?').run(userId, id);
  return db.prepare('DELETE FROM panels WHERE user_id = ? AND id = ?').run(userId, id);
}

/** 全部节点小面板（主页面数据源，某用户）：只列出已启用连接绑定的。
 * 面板内按移动端宫格顺序 grid_order 排列（与桌面 2560×1440 布局无关）。 */
function listWidgets(userId) {
  const rows = db.prepare(
    `SELECT p.* FROM topic_panels p
     LEFT JOIN mqtt_connections c ON c.id = p.connection_id
     WHERE p.user_id = ? AND (p.connection_id IS NULL OR c.enabled = 1)
     ORDER BY p.panel_id, p.grid_order, p.id`
  ).all(userId);
  return rows.map((r) => {
    let stale = false;
    if (r.last_seen) {
      const ts = new Date(r.last_seen).getTime();
      stale = !Number.isNaN(ts) && Date.now() - ts > PANEL_STALE_AFTER_MS;
    }
    return { ...r, stale };
  });
}

function getWidget(userId, id) {
  return db.prepare('SELECT * FROM topic_panels WHERE user_id = ? AND id = ?').get(userId, id);
}

function updateWidgetLayout(userId, id, x, y, w, h) {
  db.prepare('UPDATE topic_panels SET x = ?, y = ?, w = ?, h = ? WHERE user_id = ? AND id = ?').run(x, y, w, h, userId, id);
  return getWidget(userId, id);
}

/** 保存某面板内节点小面板的移动端宫格顺序：orderIds 须为该面板当前全部小面板 id 的排列。
 * 事务内重编号（插入位移重排后一次性提交）。返回 null 表示校验失败（未覆盖全部小面板）。 */
function setWidgetGridOrder(userId, panelId, orderIds) {
  const list = db.prepare('SELECT id FROM topic_panels WHERE user_id = ? AND panel_id = ?').all(userId, panelId);
  const have = new Set(list.map((r) => r.id));
  if (have.size !== orderIds.length || orderIds.some((id) => !have.has(id))) return null;
  const upd = db.prepare('UPDATE topic_panels SET grid_order = ? WHERE user_id = ? AND id = ?');
  db.exec('BEGIN');
  try {
    orderIds.forEach((id, i) => upd.run(i, userId, id));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { ok: true };
}

/** 设置面板的移动端宫格列数（1..6）。 */
function setPanelGridCols(userId, panelId, cols) {
  cols = Math.max(1, Math.min(6, Math.trunc(Number(cols)) || 2));
  db.prepare('UPDATE panels SET grid_cols = ? WHERE user_id = ? AND id = ?').run(cols, userId, panelId);
  return getPanel(userId, panelId);
}

/** 部分更新小面板图表设置（show_temp/show_hum/show_bat/chart_range/chart_layout，undefined 不修改）。 */
function updateWidgetSettings(userId, id, settings) {
  const sets = [];
  const params = { user_id: userId, id };
  for (const k of ['show_temp', 'show_hum', 'show_bat']) {
    if (settings[k] !== undefined) {
      sets.push(`${k} = @${k}`);
      params[k] = settings[k] ? 1 : 0;
    }
  }
  if (settings.chart_range !== undefined) {
    sets.push('chart_range = @chart_range');
    params.chart_range = settings.chart_range;
  }
  if (settings.chart_layout !== undefined) {
    sets.push('chart_layout = @chart_layout');
    params.chart_layout = settings.chart_layout;
  }
  if (!sets.length) return getWidget(userId, id);
  db.prepare(`UPDATE topic_panels SET ${sets.join(', ')} WHERE user_id = @user_id AND id = @id`).run(params);
  return getWidget(userId, id);
}

/** 小面板 → 命中的节点 (gateway_id, device_id) 列表（曲线历史数据用）：
 * 主题是具体节点主题时直接解析；含通配符时按来源连接内重建各节点主题匹配。 */
function resolveWidgetNodeIds(w) {
  const out = [];
  const m = /^gateway_(\d+)\/node_(\d+)\/([^/]+)$/.exec(String(w.topic || ''));
  if (m) {
    const gid = Number(m[1]);
    const did = Number(m[2]);
    if (getNode(w.user_id, gid, did)) out.push({ gateway_id: gid, device_id: did });
    return out;
  }
  const nodes = db.prepare('SELECT gateway_id, device_id, device_type FROM nodes WHERE connection_id = ? AND user_id = ?')
    .all(w.connection_id, w.user_id);
  for (const n of nodes) {
    const t = `gateway_${n.gateway_id}/node_${n.device_id}/${n.device_type || 'thermo'}`;
    if (topicMatches(w.topic, t)) out.push({ gateway_id: n.gateway_id, device_id: n.device_id });
  }
  return out;
}

/** 历史点抽稀：按数量均分桶、桶内取均值，首尾时间戳锚定，输出不超过 maxPoints 条（长范围曲线降点用）。 */
function downsampleTelemetry(rows, maxPoints) {
  const n = rows.length;
  if (n <= maxPoints) return rows;
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const out = [];
  for (let i = 0; i < maxPoints; i++) {
    const start = Math.floor(i * n / maxPoints);
    const end = Math.max(start + 1, Math.floor((i + 1) * n / maxPoints));
    let temp = [], hum = [], bat = [], rssi = null;
    for (let j = start; j < end; j++) {
      const p = rows[j];
      if (typeof p.temperature === 'number') temp.push(p.temperature);
      if (typeof p.humidity === 'number') hum.push(p.humidity);
      if (typeof p.battery === 'number') bat.push(p.battery);
      if (p.rssi != null) rssi = p.rssi;
    }
    const mid = rows[Math.floor((start + end - 1) / 2)];
    out.push({
      temperature: avg(temp),
      humidity: avg(hum),
      battery: avg(bat),
      rssi,
      // 首尾用真实边界时间戳，保证曲线 x 轴两端与窗口对齐
      received_at: i === 0 ? rows[0].received_at
        : i === maxPoints - 1 ? rows[n - 1].received_at
        : mid.received_at,
    });
  }
  return out;
}

/** 小面板曲线历史：命中节点历史合并、按时间升序；可给 since（ISO，时间窗口起点）过滤，并抽稀到 limit 条。 */
function listWidgetTelemetry(widget, opts = {}) {
  const ids = resolveWidgetNodeIds(widget);
  if (!ids.length) return [];
  const limit = (opts.limit && opts.limit > 0) ? Math.trunc(opts.limit) : 200;
  const since = opts.since || null;
  const rows = [];
  for (const n of ids) {
    const q = since
      ? 'SELECT temperature, humidity, battery, rssi, received_at' +
        ' FROM telemetry WHERE user_id = ? AND gateway_id = ? AND node_id = ? AND received_at >= ?'
      : 'SELECT temperature, humidity, battery, rssi, received_at' +
        ' FROM telemetry WHERE user_id = ? AND gateway_id = ? AND node_id = ?';
    const params = since ? [widget.user_id, n.gateway_id, n.device_id, since] : [widget.user_id, n.gateway_id, n.device_id];
    rows.push(...db.prepare(q).all(...params));
  }
  rows.sort((a, b) => (a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : 0));
  if (!since) return rows.slice(-limit);
  return downsampleTelemetry(rows, limit);
}

/** 向某面板添加一个绑定订阅主题的节点小面板（同面板同主题去重）。
 * 移动端宫格顺序 grid_order 追加到面板末尾（新小面板排最后）。 */
function createWidget(userId, panelId, node) {
  const exist = db.prepare(
    'SELECT id FROM topic_panels WHERE user_id = ? AND panel_id = ? AND connection_id = ? AND topic = ?'
  ).get(userId, panelId, node.connection_id, node.topic);
  if (exist) return getWidget(userId, exist.id);
  const max = db.prepare(
    'SELECT COALESCE(MAX(grid_order), -1) AS m FROM topic_panels WHERE user_id = ? AND panel_id = ?'
  ).get(userId, panelId).m;
  const info = db.prepare(
    'INSERT INTO topic_panels (user_id, panel_id, connection_id, topic, name, type, grid_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, panelId, node.connection_id, node.topic, node.name || '', node.type || 'thermo', max + 1);
  return getWidget(userId, info.lastInsertRowid);
}

function deleteWidget(userId, id) {
  return db.prepare('DELETE FROM topic_panels WHERE user_id = ? AND id = ?').run(userId, id);
}

const NODE_STALE_AFTER_MS = 10 * 60 * 1000; // 超过 10 分钟未上报视为离线

/** 为连接的订阅主题补充最新上报节点信息（订阅页在主题后展示数据/时间/状态）。
 * 每个主题命中多个节点时取 last_seen 最新的一个；无命中返回 latest: null。 */
function latestNodesByTopic(userId, connectionId, topics) {
  const nodes = db.prepare('SELECT * FROM nodes WHERE user_id = ? AND connection_id = ?')
    .all(userId, connectionId);
  return (topics || []).map((t) => {
    let best = null;
    for (const n of nodes) {
      const nt = `gateway_${n.gateway_id}/node_${n.device_id}/${n.device_type || 'thermo'}`;
      if (topicMatches(t.topic, nt) && (!best || (n.last_seen || '') > (best.last_seen || ''))) {
        best = n;
      }
    }
    let latest = null;
    if (best) {
      let stale = false;
      if (best.last_seen) {
        const ts = new Date(best.last_seen).getTime();
        stale = !Number.isNaN(ts) && Date.now() - ts > NODE_STALE_AFTER_MS;
      }
      latest = {
        gateway_id: best.gateway_id,
        device_id: best.device_id,
        device_type: best.device_type || '',
        name: best.name || '',
        temperature: best.last_temperature,
        humidity: best.last_humidity,
        battery: best.last_battery,
        rssi: best.last_rssi,
        last_seen: best.last_seen,
        stale,
      };
    }
    return { ...t, latest };
  });
}

/** 可添加的节点（订阅主题池）：该用户所有已启用连接的订阅主题，供「添加节点」下拉使用。 */
function listAvailableNodes(userId) {
  const nodes = [];
  for (const conn of listUserMqttConnections(userId)) {
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
  // 用户 / 会话
  createUser,
  getUserByUsername,
  getUserById,
  listUsers,
  setUserPassword,
  setUserAvatar,
  setUserRole,
  countAdmins,
  deleteUser,
  createSession,
  getSession,
  deleteSession,
  touchSession,
  getUserSetting,
  setUserSetting,
  seedDefaultConnection,
  // 节点
  listNodes,
  getNode,
  updateNode,
  listTelemetry,
  cleanupTelemetry,
  upsertTelemetry,
  // 面板布局（遗留）
  getLayouts,
  getLayout,
  upsertLayout,
  // 设置
  getSettings,
  setSetting,
  // MQTT 连接
  listMqttConnections,
  listUserMqttConnections,
  getMqttConnection,
  insertMqttConnection,
  updateMqttConnection,
  deleteMqttConnection,
  topicMatches,
  syncTopicPanels,
  deleteTopicPanelsForConnection,
  routeMessageToPanels,
  // 面板容器 + 节点小面板
  listPanels,
  getPanel,
  createPanel,
  updatePanel,
  deletePanel,
  listWidgets,
  getWidget,
  updateWidgetLayout,
  updateWidgetSettings,
  setWidgetGridOrder,
  setPanelGridCols,
  listWidgetTelemetry,
  createWidget,
  deleteWidget,
  listAvailableNodes,
  latestNodesByTopic,
};
