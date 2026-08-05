/* 设置路由：面板锁定状态（按用户隔离，存 user_settings 表）。 */
const express = require('express');
const db = require('../db');

const router = express.Router();

function settingsToJson(userId) {
  return {
    lock_all: db.getUserSetting(userId, 'lock_all') === '1',
  };
}

router.get('/', (req, res) => {
  res.json(settingsToJson(req.user.id));
});

router.put('/', (req, res) => {
  const body = req.body || {};
  if (typeof body.lock_all === 'boolean') {
    db.setUserSetting(req.user.id, 'lock_all', body.lock_all ? '1' : '0');
  }
  res.json(settingsToJson(req.user.id));
});

module.exports = { router };
