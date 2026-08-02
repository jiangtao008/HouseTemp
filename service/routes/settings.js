/* 设置路由：背景图、面板锁定状态；背景图片上传。 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const db = require('../db');

const router = express.Router();
const cfg = config.load();

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];

function settingsToJson() {
  const s = db.getSettings();
  return {
    background: s.background ? s.background : null,
    lock_all: s.lock_all === '1',
  };
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(cfg.storage.upload_dir, { recursive: true });
      cb(null, cfg.storage.upload_dir);
    },
    filename: (_req, file, cb) => {
      const ext = safeExt(file.originalname || '', file.mimetype);
      const name = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}${ext}`;
      cb(null, name);
    },
  }),
  limits: { fileSize: cfg.storage.max_upload_mb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`不支持的图片类型: ${file.mimetype}`));
  },
});

function safeExt(filename, mimetype) {
  const ext = path.extname(filename);
  if (/^\.[a-zA-Z0-9]{1,8}$/.test(ext)) return ext.toLowerCase();
  return { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp' }[mimetype] || '.jpg';
}

router.get('/', (_req, res) => {
  res.json(settingsToJson());
});

router.put('/', (req, res) => {
  const body = req.body || {};
  if (Object.prototype.hasOwnProperty.call(body, 'background')) {
    const value = (body.background || '').toString().trim();
    if (value && !value.startsWith('/uploads/')) {
      return res.status(400).json({ detail: 'background 必须以 /uploads/ 开头或为空' });
    }
    db.setSetting('background', value);
  }
  if (typeof body.lock_all === 'boolean') {
    db.setSetting('lock_all', body.lock_all ? '1' : '0');
  }
  res.json(settingsToJson());
});

router.post('/background', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ detail: '缺少文件字段 file' });
  const url = `/uploads/${req.file.filename}`;
  db.setSetting('background', url);
  console.log(`背景图已保存: ${req.file.filename} (${req.file.size} 字节)`);
  res.json({ background: url });
});

module.exports = { router, settingsToJson };
