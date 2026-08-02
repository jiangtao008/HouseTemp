/* 面板布局路由：读取/保存节点面板位置（百分比坐标）。 */
const express = require('express');
const db = require('../db');

const router = express.Router();

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function rowToJson(row) {
  return { node_id: row.node_id, x: row.x, y: row.y, w: row.w, h: row.h };
}

router.get('/', (_req, res) => {
  res.json({ layouts: db.getLayouts().map(rowToJson) });
});

router.put('/:deviceId', (req, res) => {
  const deviceId = Number(req.params.deviceId);
  if (!db.getNode(deviceId)) {
    return res.status(404).json({ detail: `节点 ${deviceId} 不存在` });
  }
  const b = req.body || {};
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const w = clamp(num(b.w, 20), 5, 100);
  const h = clamp(num(b.h, 24), 5, 100);
  const x = clamp(num(b.x, 10), 0, 100 - w);
  const y = clamp(num(b.y, 10), 0, 100 - h);
  db.upsertLayout(deviceId, x, y, w, h);
  res.json(rowToJson(db.getLayout(deviceId)));
});

module.exports = router;
