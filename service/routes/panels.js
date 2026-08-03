/* 主题面板路由：主页面节点面板（一个订阅主题 = 一个面板）。
 * 面板由订阅主题配置驱动（routes/mqtt.js 保存时 syncTopicPanels），数据由 MQTT 消息路由填充。 */
const express = require('express');
const db = require('../db');

const router = express.Router();

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function panelToJson(p) {
  return {
    id: p.id,
    connection_id: p.connection_id,
    topic: p.topic,
    name: p.name,
    type: p.type,
    x: p.x, y: p.y, w: p.w, h: p.h,
    temperature: p.temperature,
    humidity: p.humidity,
    battery: p.battery,
    rssi: p.rssi,
    last_seen: p.last_seen,
    stale: !!p.stale,
  };
}

router.get('/', (_req, res) => {
  res.json({ panels: db.listPanels().map(panelToJson) });
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const panel = db.getPanel(id);
  if (!panel) return res.status(404).json({ detail: '面板不存在' });
  const b = req.body || {};
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const w = clamp(num(b.w, 20), 5, 100);
  const h = clamp(num(b.h, 24), 5, 100);
  const x = clamp(num(b.x, 10), 0, 100 - w);
  const y = clamp(num(b.y, 10), 0, 100 - h);
  res.json(panelToJson(db.updatePanelLayout(id, x, y, w, h)));
});

module.exports = router;
