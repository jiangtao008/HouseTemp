/* 用户管理路由（仅管理员）：列出用户、重置密码、删除用户。
 * 管理员仅做账号管理，看不到其他用户的配置/数据。 */
const express = require('express');
const db = require('../db');
const mqttClient = require('../mqtt');
const { requireAdmin, hashPassword } = require('./auth');

const router = express.Router();

router.use(requireAdmin);

router.get('/', (_req, res) => {
  res.json({ users: db.listUsers() });   // listUsers 只含 id/username/role/created_at，无密码
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
  // 先断开其全部 MQTT 连接，再级联删除数据
  for (const conn of db.listUserMqttConnections(id)) {
    try { mqttClient.stopConnection(conn.id); } catch (e) { /* 忽略 */ }
  }
  db.deleteUser(id);
  res.json({ ok: true });
});

module.exports = router;
