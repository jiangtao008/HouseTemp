/* 节点路由：列出/更新发现的节点（订阅状态、显示名）。 */
const express = require('express');
const db = require('../db');

const router = express.Router();

const STALE_AFTER_MS = 10 * 60 * 1000; // 超过 10 分钟未上报视为离线

function nodeToJson(row) {
  const gatewayId = row.gateway_id;
  const deviceId = row.device_id;
  const name = row.name || '';
  const display = row.display_name;
  let effective;
  if (display) effective = display;
  else if (name && name !== 'Unnamed') effective = name;
  else effective = `节点-${deviceId}`;

  let stale = false;
  if (row.last_seen) {
    const ts = new Date(row.last_seen).getTime();
    stale = !Number.isNaN(ts) && Date.now() - ts > STALE_AFTER_MS;
  }

  return {
    gateway_id: gatewayId,
    device_id: deviceId,
    connection_id: row.connection_id ?? null,
    device_type: row.device_type || '',
    // 节点对应消息 Topic：标准格式 gateway_<gw>/node_<id>/<type> 可由身份还原；
    // 旧格式/任意主题上报的节点无 device_type，无法还原则返回空串
    topic: row.device_type ? `gateway_${gatewayId}/node_${deviceId}/${row.device_type}` : '',
    name,
    display_name: display,
    effective_name: effective,
    subscribed: !!row.subscribed,
    last_seen: row.last_seen,
    temperature: row.last_temperature,
    humidity: row.last_humidity,
    battery: row.last_battery,
    rssi: row.last_rssi,
    stale,
  };
}

router.get('/', (req, res) => {
  const subscribedOnly = req.query.subscribed === 'true';
  const gatewayId = req.query.gateway !== undefined ? Number(req.query.gateway) : undefined;
  res.json(db.listNodes({ userId: req.user.id, subscribedOnly, gatewayId }).map(nodeToJson));
});

router.put('/:gatewayId/:deviceId', (req, res) => {
  const gatewayId = Number(req.params.gatewayId);
  const deviceId = Number(req.params.deviceId);
  const node = db.getNode(req.user.id, gatewayId, deviceId);
  if (!node) return res.status(404).json({ detail: `节点 ${gatewayId}/${deviceId} 不存在` });

  const body = req.body || {};
  let displayName;
  if (Object.prototype.hasOwnProperty.call(body, 'display_name')) displayName = body.display_name;
  db.updateNode(req.user.id, gatewayId, deviceId, { subscribed: body.subscribed, displayName });

  res.json(nodeToJson(db.getNode(req.user.id, gatewayId, deviceId)));
});

module.exports = router;
