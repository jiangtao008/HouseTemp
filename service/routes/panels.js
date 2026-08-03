/* 主题面板路由：主页面节点面板（一个订阅主题 = 一个面板）。
 * 面板由订阅主题配置驱动（routes/mqtt.js 保存时 syncTopicPanels），数据由 MQTT 消息路由填充。
 * 坐标单位为像素，基于 2560×1440 虚拟舞台（见 db.js 的 STAGE_W/STAGE_H）。 */
const express = require('express');
const db = require('../db');

const router = express.Router();

const { STAGE_W, STAGE_H } = db;
const MIN_W = 120;   // 与前端 public/style.css 的 .node-panel min-width 一致
const MIN_H = 90;    // 与前端 public/style.css 的 .node-panel min-height 一致
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
  const w = clamp(num(b.w, 480), MIN_W, STAGE_W);
  const h = clamp(num(b.h, 300), MIN_H, STAGE_H);
  const x = clamp(num(b.x, 150), 0, STAGE_W - w);
  const y = clamp(num(b.y, 110), 0, STAGE_H - h);
  res.json(panelToJson(db.updatePanelLayout(id, x, y, w, h)));
});

module.exports = router;
