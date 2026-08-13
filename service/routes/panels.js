/* 面板路由：面板容器 + 节点小面板（按用户隔离，req.user.id）。
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

// 图表时间范围白名单（与前端设置下拉一致）；时间轴窗口 = now - rangeMs → now
const CHART_RANGES = {
  '1h': 3600e3, '6h': 6 * 3600e3, '1d': 86400e3, '3d': 3 * 86400e3,
  '7d': 7 * 86400e3, '15d': 15 * 86400e3, '1M': 30 * 86400e3,
  '3M': 90 * 86400e3, '6M': 180 * 86400e3, '1Y': 365 * 86400e3,
};

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
    show_temp: w.show_temp !== 0,
    show_hum: w.show_hum !== 0,
    show_bat: w.show_bat !== 0,
    chart_range: w.chart_range || '1d',
    chart_layout: w.chart_layout || 'v',
    grid_order: w.grid_order || 0,   // 移动端宫格顺序（与桌面 2560×1440 布局独立）
  };
}

/** 全部面板容器 + 全部节点小面板（一次返回，量很小）。 */
router.get('/', (req, res) => {
  res.json({ panels: db.listPanels(req.user.id), widgets: db.listWidgets(req.user.id).map(widgetToJson) });
});

/** 创建空白面板容器。 */
router.post('/', (req, res) => {
  res.status(201).json(db.createPanel(req.user.id));
});

/** 可添加的节点（订阅主题池，仅本用户的）。 */
router.get('/nodes', (req, res) => {
  res.json({ nodes: db.listAvailableNodes(req.user.id) });
});

/** 部分更新面板：改名 {name} 或锁定/解锁 {locked}。锁定开关始终允许；其他修改在锁定时拒绝。 */
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const panel = db.getPanel(req.user.id, id);
  if (!panel) return res.status(404).json({ detail: '面板不存在' });
  const b = req.body || {};
  if (b.locked !== undefined) {
    return res.json(db.updatePanel(req.user.id, id, { locked: !!b.locked }));
  }
  if (panel.locked) return res.status(403).json({ detail: '面板已锁定，请先解锁' });
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return res.status(400).json({ detail: '面板名不能为空' });
    return res.json(db.updatePanel(req.user.id, id, { name }));
  }
  return res.status(400).json({ detail: '没有可更新的字段' });
});

/** 向某面板添加一个节点小面板：{ connection_id, topic }。 */
router.post('/:panelId/widgets', (req, res) => {
  const panelId = Number(req.params.panelId);
  const panel = db.getPanel(req.user.id, panelId);
  if (!panel) return res.status(404).json({ detail: '面板不存在' });
  if (panel.locked) return res.status(403).json({ detail: '面板已锁定，请先解锁' });
  const b = req.body || {};
  const connectionId = Number(b.connection_id);
  const topic = String(b.topic == null ? '' : b.topic).trim();
  if (!Number.isInteger(connectionId) || !topic) {
    return res.status(400).json({ detail: '缺少 connection_id 或 topic' });
  }
  const conn = db.getMqttConnection(connectionId);
  if (!conn || !conn.enabled || conn.user_id !== req.user.id) {
    return res.status(400).json({ detail: '连接不存在或已停用' });
  }
  const t = (conn.topics || []).find((x) => x.topic === topic);
  if (!t) return res.status(400).json({ detail: '该主题不在连接的订阅列表中' });
  const w = db.createWidget(req.user.id, panelId, { connection_id: connectionId, topic, name: t.name, type: t.type });
  res.status(201).json(widgetToJson(w));
});

/** 删除面板容器（其内节点小面板一并删除）。 */
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const panel = db.getPanel(req.user.id, id);
  if (!panel) return res.status(404).json({ detail: '面板不存在' });
  if (panel.locked) return res.status(403).json({ detail: '面板已锁定，请先解锁' });
  db.deletePanel(req.user.id, id);
  res.json({ ok: true });
});

/** 保存面板内小面板的移动端宫格顺序：{ order: [小面板id,...] }，须为该面板全部小面板的排列。
 * 插入位移重排后一次性提交（事务内重编号），与桌面布局互不影响。 */
router.put('/:panelId/grid-order', (req, res) => {
  const panelId = Number(req.params.panelId);
  const panel = db.getPanel(req.user.id, panelId);
  if (!panel) return res.status(404).json({ detail: '面板不存在' });
  const order = (req.body && Array.isArray(req.body.order)) ? req.body.order : null;
  if (!order) return res.status(400).json({ detail: '缺少 order（小面板 id 数组）' });
  const ids = order.map((v) => Number(v));
  if (ids.some((v) => !Number.isInteger(v))) return res.status(400).json({ detail: 'order 必须是小面板 id 数组' });
  const r = db.setWidgetGridOrder(req.user.id, panelId, ids);
  if (!r) return res.status(400).json({ detail: 'order 未覆盖面板全部小面板' });
  res.json({ ok: true });
});

/** 设置面板的移动端宫格列数：{ cols }（1..6，按面板独立配置）。 */
router.put('/:panelId/grid-cols', (req, res) => {
  const panelId = Number(req.params.panelId);
  const panel = db.getPanel(req.user.id, panelId);
  if (!panel) return res.status(404).json({ detail: '面板不存在' });
  const cols = Number((req.body || {}).cols);
  if (!Number.isFinite(cols)) return res.status(400).json({ detail: '缺少 cols' });
  res.json(db.setPanelGridCols(req.user.id, panelId, cols));
});

/** 保存节点小面板像素坐标。 */
router.put('/widgets/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.getWidget(req.user.id, id)) return res.status(404).json({ detail: '节点小面板不存在' });
  const b = req.body || {};
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const w = clamp(num(b.w, 240), MIN_W, STAGE_W);
  const h = clamp(num(b.h, 200), MIN_H, STAGE_H);
  const x = clamp(num(b.x, 10), 0, STAGE_W - w);
  const y = clamp(num(b.y, 10), 0, STAGE_H - h);
  res.json(widgetToJson(db.updateWidgetLayout(req.user.id, id, x, y, w, h)));
});

/** 小面板图表设置（显示温度/湿度/电量曲线 + 时间范围 + 布局）。部分更新；面板锁定不拦截（显示偏好，非结构性修改）。 */
router.put('/widgets/:id/settings', (req, res) => {
  const id = Number(req.params.id);
  if (!db.getWidget(req.user.id, id)) return res.status(404).json({ detail: '节点小面板不存在' });
  const b = req.body || {};
  const settings = {};
  for (const k of ['show_temp', 'show_hum', 'show_bat']) {
    if (b[k] !== undefined) settings[k] = !!b[k];
  }
  if (b.chart_range !== undefined) {
    if (!CHART_RANGES[b.chart_range]) {
      return res.status(400).json({ detail: `不支持的时间范围：${b.chart_range}` });
    }
    settings.chart_range = String(b.chart_range);
  }
  if (b.chart_layout !== undefined) {
    if (b.chart_layout !== 'v' && b.chart_layout !== 'h') {
      return res.status(400).json({ detail: `不支持的图表布局：${b.chart_layout}` });
    }
    settings.chart_layout = String(b.chart_layout);
  }
  if (!Object.keys(settings).length) return res.status(400).json({ detail: '没有可更新的设置项' });
  res.json(widgetToJson(db.updateWidgetSettings(req.user.id, id, settings)));
});

/** 小面板曲线历史（图表数据）：按绑定主题命中节点，合并历史、时间升序；
 * range 指定时间窗口（1h/6h/1d/…/1Y），只取窗口内数据并抽稀到 limit 条。 */
router.get('/widgets/:id/telemetry', (req, res) => {
  const id = Number(req.params.id);
  const widget = db.getWidget(req.user.id, id);
  if (!widget) return res.status(404).json({ detail: '节点小面板不存在' });
  let limit = Number(req.query.limit) || 300;
  limit = Math.max(1, Math.min(1000, Math.trunc(limit)));
  const rangeKey = CHART_RANGES[req.query.range] ? String(req.query.range) : '1d';
  const since = new Date(Date.now() - CHART_RANGES[rangeKey]).toISOString();
  const points = db.listWidgetTelemetry(widget, { limit, since });
  res.json({ widget_id: id, range: rangeKey, count: points.length, points });
});

/** 删除节点小面板。 */
router.delete('/widgets/:id', (req, res) => {
  const id = Number(req.params.id);
  const widget = db.getWidget(req.user.id, id);
  if (!widget) return res.status(404).json({ detail: '节点小面板不存在' });
  const panel = db.getPanel(req.user.id, widget.panel_id);
  if (panel && panel.locked) return res.status(403).json({ detail: '面板已锁定，请先解锁' });
  db.deleteWidget(req.user.id, id);
  res.json({ ok: true });
});

module.exports = router;
