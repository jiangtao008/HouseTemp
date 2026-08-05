/* 配置加载：优先读取 config.json，缺失时回退到 config.example.json 的默认值。
 * 数据库目录的相对路径解析为 service/ 下的绝对路径。 */
const fs = require('fs');
const path = require('path');

const SERVICE_DIR = __dirname;
const DEFAULT_PATH = path.join(SERVICE_DIR, 'config.example.json');
const CONFIG_PATH = path.join(SERVICE_DIR, 'config.json');

const DEFAULTS = {
  mqtt: { host: '127.0.0.1', port: 1883, username: '', password: '', topics: [] },
  database: { path: 'data/thermo.db', retention_days: 30 },
  server: { host: '0.0.0.0', port: 8000 },
  // 初始管理员：启动时按此创建（或提升）管理员账号；username/password 均为空则不创建
  admin: { username: '', password: '' },
};

function deepMerge(base, extra) {
  for (const key of Object.keys(extra || {})) {
    const b = base[key];
    const e = extra[key];
    if (e && typeof e === 'object' && !Array.isArray(e) && b && typeof b === 'object' && !Array.isArray(b)) {
      deepMerge(b, e);
    } else {
      base[key] = e;
    }
  }
  return base;
}

let _cached = null;
function load() {
  if (_cached) return _cached;
  let user = {};
  if (fs.existsSync(CONFIG_PATH)) {
    user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  const cfg = deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), user);
  cfg.database.path = abs(cfg.database.path);
  _cached = cfg;
  return cfg;
}

function abs(p) {
  return path.isAbsolute(p) ? p : path.join(SERVICE_DIR, p);
}

module.exports = { load, SERVICE_DIR };
