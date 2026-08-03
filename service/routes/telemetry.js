/* 历史数据路由：查询单个节点的温湿度历史。 */
const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/:gatewayId/:deviceId', (req, res) => {
  const gatewayId = Number(req.params.gatewayId);
  const deviceId = Number(req.params.deviceId);
  if (!db.getNode(gatewayId, deviceId)) {
    return res.status(404).json({ detail: `节点 ${gatewayId}/${deviceId} 不存在` });
  }
  let limit = Number(req.query.limit) || 100;
  limit = Math.max(1, Math.min(1000, Math.trunc(limit)));
  const points = db.listTelemetry(gatewayId, deviceId, limit);
  res.json({ gateway_id: gatewayId, device_id: deviceId, count: points.length, points });
});

module.exports = router;
