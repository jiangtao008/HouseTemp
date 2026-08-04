/* 面板路由：面板容器 + 节点小面板。
 * panels 表 = 面板容器（主舞台一次显示一个，侧边栏面板管理表逐项配置）；
 * topic_panels 表 = 节点小面板，归属某容器、绑定一个订阅主题，数据由 MQTT 消息路由填充。
 * 坐标单位为像素（见 db.js 的 STAGE_W/STAGE_H）。 */
const express = require('express');
const db = require('../db');

const router = express.Router();

const { STAGE_W, STAGE_H } = db;
const MIN_W = 120;   // 与前端 public/style.css 的 .node-panel min-width 一致
const MIN_H = 90;    // 与前端 public/style.css 的 .node-panel min-height 一致
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function widgetToJson(w) {
  return {
    id: w.id,
    panel_id: w.panel_id,
    connection_id: w.connection_id,
    topic: w.topic,
    name: w.name,
    type: w.type,
    x: w.x, y: w.y, w: w.w, h: w.h,
    temperature: w.temperature,
    humidity: w.humidity,
    battery: w.battery,
    rssi: w.rssi,
    last_seen: w.last_seen,
    stale: !!w.stale,
  };
}

/** 全部面板容器 + 全部节点小面板（一次返回，量很小）。 */
router.get('/', (_req, res) => {
  res.json({ panels: db.listPanels(), widgets: db.listWidgets().map(widgetToJson) });
});

/** 创建空白面板容器。 */
router.post('/', (_req, res) => {
  res.status(201).json(db.createPanel());
});

/** 可添加的节点（订阅主题池）。 */
router.get('/nodes', (_req, res) => {
  res.json({ nodes: db.listAvailableNodes() });
});

/** 部分更新面板：改名 {name} 或锁定/解锁 {locked}。锁定开关始终允许；其他修改在锁定时拒绝。 */
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const panel = db.getPanel(id);
  if (!panel) return res.status(404).json({ detail: '面板不存在' });
  const b = req.body || {};
  if (b.locked !== undefined) {
    return res.json(db.updatePanel(id, { locked: !!b.locked }));
  }
  if (panel.locked) return res.status(403).json({ detail: '面板已锁定，请先解锁' });
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return res.status(400).json({ detail: '面板名不能为空' });
    return res.json(db.updatePanel(id, { name }));
  }
  return res.status(400).json({ detail: '没有可更新的字段' });
});

/** 向某面板添加一个节点小面板：{ connection_id, topic }。 */
router.post('/:panelId/widgets', (req, res) => {
  const panelId = Number(req.params.panelId);
  const panel = db.getPanel(panelId);
  if (!panel) return res.status(404).json({ detail: '面板不存在' });
  if (panel.locked) return res.status(403).json({ detail: '面板已锁定，请先解锁' });
  const b = req.body || {};
  const connectionId = Number(b.connection_id);
  const topic = String(b.topic == null ? '' : b.topic).trim();
  if (!Number.isInteger(connectionId) || !topic) {
    return res.status(400).json({ detail: '缺少 connection_id 或 topic' });
  }
  const conn = db.getMqttConnection(connectionId);
  if (!conn || !conn.enabled) return res.status(400).json({ detail: '连接不存在或已停用' });
  const t = (conn.topics || []).find((x) => x.topic === topic);
  if (!t) return res.status(400).json({ detail: '该主题不在连接的订阅列表中' });
  const w = db.createWidget(panelId, { connection_id: connectionId, topic, name: t.name, type: t.type });
  res.status(201).json(widgetToJson(w));
});

/** 删除面板容器（其内节点小面板一并删除）。 */
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const panel = db.getPanel(id);
  if (!panel) return res.status(404).json({ detail: '面板不存在' });
  if (panel.locked) return res.status(403).json({ detail: '面板已锁定，请先解锁' });
  db.deletePanel(id);
  res.json({ ok: true });
});

/** 保存节点小面板像素坐标。 */
router.put('/widgets/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.getWidget(id)) return res.status(404).json({ detail: '节点小面板不存在' });
  const b = req.body || {};
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const w = clamp(num(b.w, 240), MIN_W, STAGE_W);
  const h = clamp(num(b.h, 200), MIN_H, STAGE_H);
  const x = clamp(num(b.x, 10), 0, STAGE_W - w);
  const y = clamp(num(b.y, 10), 0, STAGE_H - h);
  res.json(widgetToJson(db.updateWidgetLayout(id, x, y, w, h)));
});

/** 删除节点小面板。 */
router.delete('/widgets/:id', (req, res) => {
  const id = Number(req.params.id);
  const widget = db.getWidget(id);
  if (!widget) return res.status(404).json({ detail: '节点小面板不存在' });
  const panel = db.getPanel(widget.panel_id);
  if (panel && panel.locked) return res.status(403).json({ detail: '面板已锁定，请先解锁' });
  db.deleteWidget(id);
  res.json({ ok: true });
});

module.exports = router;
