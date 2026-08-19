/* 认证路由 + 鉴权中间件：登录 / 注册 / 登出 / 会话校验 / 初始管理员引导。
 *
 * 认证方式：Bearer Token。token 为随机 hex，落库 sessions 表（跨重启保持登录态，
 * 长期有效直到手动退出或被删除）。密码用 Node 内置 crypto.scrypt 哈希，无新增依赖。
 *
 * 导出：router（/api/auth/*）、requireAuth（其余 /api/* 用）、requireAdmin、ensureAdmin。 */
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');

const router = express.Router();

// ---------------------------------------------------------------------------
// 头像上传（multer 存到 public/uploads，URL 即 /uploads/文件名）
// ---------------------------------------------------------------------------

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      // 时间戳 + 随机数命名，避免文件名冲突；扩展名取原图（小写化，未知时兜底 .png）
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `${Date.now()}_${Math.round(Math.random() * 1e9)}${/\.(png|jpe?g|gif|webp)$/.test(ext) ? ext : '.png'}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },   // 上限 2MB
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('仅支持 PNG / JPG / GIF / WebP 图片'));
  },
});

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
  res.json({ token, username: user.username, role: user.role, userId: user.id, avatar: user.avatar || '' });
});

/** 注册码错误 → HTTP 状态 + 中文提示。 */
const REG_CODE_ERRORS = {
  not_found:      { status: 400, detail: '注册码不存在' },
  used:           { status: 400, detail: '注册码已被使用' },
  expired:        { status: 400, detail: '注册码已过期' },
  username_taken: { status: 409, detail: '用户名已存在' },
  unknown:        { status: 400, detail: '注册失败，请稍后重试' },
};

/** 注册：需凭有效注册码（一人一码，事务内校验码状态/有效期 → 建号 → 占码）。 */
router.post('/register', (req, res) => {
  const body = req.body || {};
  const name = String(body.username == null ? '' : body.username).trim();
  const password = String(body.password == null ? '' : body.password);
  const regCode = String(body.regCode == null ? '' : body.regCode).trim();
  if (!validUsername(name)) return res.status(400).json({ detail: '用户名需为 2-32 个字符且不含空格' });
  if (password.length < 6) return res.status(400).json({ detail: '密码至少 6 位' });
  if (!regCode) return res.status(400).json({ detail: '请输入注册码' });

  const result = db.registerWithCode(name, hashPassword(password), regCode);
  if (result.error) {
    const err = REG_CODE_ERRORS[result.error] || REG_CODE_ERRORS.unknown;
    return res.status(err.status).json({ detail: err.detail });
  }
  const user = result.user;
  // 新用户按 config.json 初始化默认 MQTT 连接（开箱即用），失败不阻断注册
  const cfg = req.app.locals.cfg || {};
  try { db.seedDefaultConnection(user.id, cfg); } catch (e) { console.error('初始化默认 MQTT 连接失败:', e); }

  const token = newToken();
  db.createSession(token, user.id);
  res.status(201).json({ token, username: user.username, role: user.role, userId: user.id, avatar: user.avatar || '' });
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
  res.json({ username: session.username, role: session.role, userId: session.user_id, avatar: session.avatar || '' });
});

/** 修改自己的密码：先校验旧密码，再写入新密码（哈希后落库）。 */
router.put('/password', (req, res) => {
  const token = parseBearer(req.headers.authorization);
  if (!token) return res.status(401).json({ detail: '未登录' });
  const session = db.getSession(token);
  if (!session) return res.status(401).json({ detail: '登录已失效' });
  const body = req.body || {};
  const oldPassword = String(body.oldPassword == null ? '' : body.oldPassword);
  const newPassword = String(body.newPassword == null ? '' : body.newPassword);
  if (!oldPassword || !newPassword) return res.status(400).json({ detail: '请输入旧密码和新密码' });
  if (newPassword.length < 6) return res.status(400).json({ detail: '新密码至少 6 位' });
  const user = db.getUserById(session.user_id);
  if (!user) return res.status(404).json({ detail: '用户不存在' });
  if (!verifyPassword(oldPassword, user.password_hash)) {
    return res.status(400).json({ detail: '旧密码不正确' });
  }
  db.setUserPassword(user.id, hashPassword(newPassword));
  res.json({ ok: true });
});

/** 上传/更换头像：multipart 表单字段 `avatar`（图片，≤2MB）。成功后删除旧头像文件。
 * 先校验登录态再交给 multer 解析，避免未登录请求也能往磁盘写文件；
 * 用回调式 multer 中间件，把「文件过大」等错误转成中文提示返回给前端。 */
router.post('/avatar', (req, res) => {
  const token = parseBearer(req.headers.authorization);
  if (!token) return res.status(401).json({ detail: '未登录' });
  const session = db.getSession(token);
  if (!session) return res.status(401).json({ detail: '登录已失效' });

  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '图片不能超过 2MB' : err.message;
      return res.status(400).json({ detail: msg });
    }
    if (!req.file) return res.status(400).json({ detail: '请选择图片文件' });

    const url = '/uploads/' + req.file.filename;
    try {
      db.setUserAvatar(session.user_id, url);
    } catch (e) {
      // 落库失败时删除刚写入的文件，避免残留
      try { fs.unlinkSync(req.file.path); } catch (e2) { /* 忽略 */ }
      throw e;
    }

    // 清理旧头像文件（仅删库里记录的这张，且不误删新上传的文件）
    if (session.avatar) {
      try {
        const oldPath = path.join(UPLOAD_DIR, path.basename(session.avatar));
        if (oldPath !== req.file.path && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      } catch (e) { /* 忽略：旧文件清理失败不影响本次修改 */ }
    }
    res.json({ avatar: url });
  });
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
