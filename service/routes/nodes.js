/* 节点路由：列出/更新发现的节点（订阅状态、显示名）。 */
const express = require('express');
const db = require('../db');

const router = express.Router();

const STALE_AFTER_MS = 10 * 60 * 1000; // 超过 10 分钟未上报视为离线

function nodeToJson(row) {
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
    device_id: deviceId,
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
  res.json(db.listNodes({ subscribedOnly }).map(nodeToJson));
});

router.put('/:deviceId', (req, res) => {
  const deviceId = Number(req.params.deviceId);
  const node = db.getNode(deviceId);
  if (!node) return res.status(404).json({ detail: `节点 ${deviceId} 不存在` });

  const body = req.body || {};
  let displayName;
  if (Object.prototype.hasOwnProperty.call(body, 'display_name')) displayName = body.display_name;
  db.updateNode(deviceId, { subscribed: body.subscribed, displayName });

  res.json(nodeToJson(db.getNode(deviceId)));
});

module.exports = router;
