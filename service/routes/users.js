/* 用户管理路由（仅管理员）：列出用户、重置密码、删除用户。
 * 管理员仅做账号管理，看不到其他用户的配置/数据。 */
const express = require('express');
const db = require('../db');
const mqttClient = require('../mqtt');
const { requireAdmin, hashPassword } = require('./auth');

const router = express.Router();

router.use(requireAdmin);

// ---------------------------------------------------------------------------
// 注册码管理（仅管理员）：列表 / 批量生成或手动录入 / 批量删除
// 注意：必须定义在 /:id 等参数路由之前，避免 /codes 被当作 id 匹配
// ---------------------------------------------------------------------------

/** 注册码列表（含状态、有效期、使用用户）。 */
router.get('/codes', (_req, res) => {
  res.json({ codes: db.listRegCodes() });
});

/** 批量添加注册码：
 *  生成模式：{ count, length, expires_at } → 随机生成 count 个；
 *  手动模式：{ codes: ['X1', 'X2', ...], expires_at } → 直接录入。
 *  expires_at 省略/null = 永久有效。 */
router.post('/codes', (req, res) => {
  const body = req.body || {};
  let expiresAt = null;
  if (body.expires_at) {
    const t = Date.parse(String(body.expires_at));
    if (Number.isNaN(t)) return res.status(400).json({ detail: '有效期格式不正确' });
    expiresAt = new Date(t).toISOString();
  }

  let codes;
  if (Array.isArray(body.codes) && body.codes.length) {
    codes = body.codes.map((c) => String(c == null ? '' : c).trim()).filter(Boolean);
    if (!codes.length) return res.status(400).json({ detail: '请输入至少一个注册码' });
  } else {
    const count = Math.min(500, Math.max(1, Math.trunc(Number(body.count)) || 1));
    const length = Math.min(16, Math.max(4, Math.trunc(Number(body.length)) || 8));
    codes = [];
    for (let i = 0; i < count; i++) codes.push(db.makeRegCode(length));
  }

  const created = db.createRegCodes(codes, expiresAt);
  res.status(201).json({ created });
});

/** 批量删除注册码：{ ids: [...] }。 */
router.delete('/codes', (req, res) => {
  const ids = (req.body || {}).ids;
  if (!Array.isArray(ids)) return res.status(400).json({ detail: '缺少 ids' });
  const info = db.deleteRegCodes(ids);
  res.json({ ok: true, changes: info.changes });
});

router.get('/', (_req, res) => {
  res.json({ users: db.listUsers() });   // listUsers 只含 id/username/role/avatar/reg_code/created_at，无密码
});

router.put('/:id/password', (req, res) => {
  const id = Number(req.params.id);
  const user = db.getUserById(id);
  if (!user) return res.status(404).json({ detail: '用户不存在' });
  const password = String((req.body || {}).password == null ? '' : (req.body || {}).password);
  if (password.length < 6) return res.status(400).json({ detail: '密码至少 6 位' });
  db.setUserPassword(id, hashPassword(password));
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ detail: '不能删除自己' });
  const user = db.getUserById(id);
  if (!user) return res.status(404).json({ detail: '用户不存在' });
  if (user.role === 'admin' && db.countAdmins() <= 1) {
    return res.status(400).json({ detail: '不能删除最后一个管理员' });
  }
  // 先断开其全部 MQTT 连接，再级联删除数据（其注册码回退为未使用）
  for (const conn of db.listUserMqttConnections(id)) {
    try { mqttClient.stopConnection(conn.id); } catch (e) { /* 忽略 */ }
  }
  db.deleteUser(id);
  res.json({ ok: true });
});

module.exports = router;
