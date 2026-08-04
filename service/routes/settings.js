/* 设置路由：面板锁定状态。 */
const express = require('express');
const db = require('../db');

const router = express.Router();

function settingsToJson() {
  const s = db.getSettings();
  return {
    lock_all: s.lock_all === '1',
  };
}

router.get('/', (_req, res) => {
  res.json(settingsToJson());
});

router.put('/', (req, res) => {
  const body = req.body || {};
  if (typeof body.lock_all === 'boolean') {
    db.setSetting('lock_all', body.lock_all ? '1' : '0');
  }
  res.json(settingsToJson());
});

module.exports = { router, settingsToJson };
