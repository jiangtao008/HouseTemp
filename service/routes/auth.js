/* 认证路由 + 鉴权中间件：登录 / 注册 / 登出 / 会话校验 / 初始管理员引导。
 *
 * 认证方式：Bearer Token。token 为随机 hex，落库 sessions 表（跨重启保持登录态，
 * 长期有效直到手动退出或被删除）。密码用 Node 内置 crypto.scrypt 哈希，无新增依赖。
 *
 * 导出：router（/api/auth/*）、requireAuth（其余 /api/* 用）、requireAdmin、ensureAdmin。 */
const crypto = require('crypto');
const express = require('express');
const db = require('../db');

const router = express.Router();

// ---------------------------------------------------------------------------
// 密码哈希 / token
// ---------------------------------------------------------------------------

/** scrypt 哈希，存 salt:hash。 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/** 常数时间比对，防时序侧信道。 */
function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const buf = Buffer.from(hash, 'hex');
    const calc = crypto.scryptSync(String(password), salt, 64);
    return buf.length === calc.length && crypto.timingSafeEqual(buf, calc);
  } catch (e) {
    return false;
  }
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseBearer(authHeader) {
  if (typeof authHeader !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// 鉴权中间件
// ---------------------------------------------------------------------------

/** 校验 Bearer token → req.user = { id, username, role }；失败 401。 */
function requireAuth(req, res, next) {
  const token = parseBearer(req.headers.authorization);
  if (!token) return res.status(401).json({ detail: '未登录' });
  const session = db.getSession(token);
  if (!session) return res.status(401).json({ detail: '登录已失效，请重新登录' });
  req.user = { id: session.user_id, username: session.username, role: session.role };
  req.token = token;
  try { db.touchSession(token); } catch (e) { /* 忽略：仅更新时间戳 */ }
  next();
}

/** 需管理员权限；须在 requireAuth 之后使用。 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ detail: '需要管理员权限' });
  }
  next();
}

// ---------------------------------------------------------------------------
// 校验规则
// ---------------------------------------------------------------------------

function validUsername(name) {
  if (typeof name !== 'string') return false;
  const s = name.trim();
  return s.length >= 2 && s.length <= 32 && !/\s/.test(s);
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

router.post('/login', (req, res) => {
  const body = req.body || {};
  const name = String(body.username == null ? '' : body.username).trim();
  const password = String(body.password == null ? '' : body.password);
  if (!name || !password) {
    return res.status(400).json({ detail: '请输入用户名和密码' });
  }
  const user = db.getUserByUsername(name);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ detail: '用户名或密码错误' });
  }
  const token = newToken();
  db.createSession(token, user.id);
  res.json({ token, username: user.username, role: user.role, userId: user.id });
});

router.post('/register', (req, res) => {
  const body = req.body || {};
  const name = String(body.username == null ? '' : body.username).trim();
  const password = String(body.password == null ? '' : body.password);
  if (!validUsername(name)) return res.status(400).json({ detail: '用户名需为 2-32 个字符且不含空格' });
  if (password.length < 6) return res.status(400).json({ detail: '密码至少 6 位' });
  if (db.getUserByUsername(name)) return res.status(409).json({ detail: '用户名已存在' });

  const user = db.createUser(name, hashPassword(password), 'user');
  // 新用户按 config.json 初始化默认 MQTT 连接（开箱即用），失败不阻断注册
  const cfg = req.app.locals.cfg || {};
  try { db.seedDefaultConnection(user.id, cfg); } catch (e) { console.error('初始化默认 MQTT 连接失败:', e); }

  const token = newToken();
  db.createSession(token, user.id);
  res.status(201).json({ token, username: user.username, role: user.role, userId: user.id });
});

router.post('/logout', (req, res) => {
  const token = parseBearer(req.headers.authorization);
  if (token) { try { db.deleteSession(token); } catch (e) { /* ignore */ } }
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const token = parseBearer(req.headers.authorization);
  if (!token) return res.status(401).json({ detail: '未登录' });
  const session = db.getSession(token);
  if (!session) return res.status(401).json({ detail: '登录已失效' });
  res.json({ username: session.username, role: session.role, userId: session.user_id });
});

// ---------------------------------------------------------------------------
// 初始管理员引导
// ---------------------------------------------------------------------------

/** 启动时按 config.json 的 admin 段确保管理员存在：用户名不存在则创建；存在则保证 role=admin（不改密码）。 */
function ensureAdmin(cfg) {
  const username = String((cfg && cfg.admin && cfg.admin.username) || '').trim();
  const password = String((cfg && cfg.admin && cfg.admin.password) || '');
  if (!username || !password) {
    console.log('未配置初始管理员（config.admin 为空），服务开放注册');
    return;
  }
  const existing = db.getUserByUsername(username);
  if (!existing) {
    db.createUser(username, hashPassword(password), 'admin');
    console.log(`初始管理员已创建: ${username}`);
  } else if (existing.role !== 'admin') {
    db.setUserRole(existing.id, 'admin');
    console.log(`用户 ${username} 已提升为管理员（来自 config.admin）`);
  }
}

module.exports = { router, requireAuth, requireAdmin, ensureAdmin, hashPassword };
