#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""模拟家庭温湿度节点周期性 MQTT 上报。

报文格式与 ble_gateway 固件一致（见 ble_gateway/src/mqtt.cpp、config.h）：
  topic:   gateway_<gateway_id>/node_<device_id>/temperature
  payload: {"name": "..", "temperature": 26.3, "humidity": 58, "battery": 3.31, "rssi": -67}

注意：node_1192217 超出 uint16_t 上限（服务端也会丢弃 id>65535 的节点），
按连续递减序列（11924→11923→…→11918）推断为 node_11917，如有误改 NODES 即可。

用法：
  python3 simulate_home_nodes.py                  # 每 30s 上报一轮，Ctrl+C 停止
  python3 simulate_home_nodes.py --once           # 只上报一轮后退出（用于验证）
  python3 simulate_home_nodes.py --interval 60 --rounds 20
"""
import argparse
import json
import math
import random
import sys
import time

import paho.mqtt.client as mqtt

BROKER_HOST = "118.89.133.140"
BROKER_PORT = 9883
GATEWAY_ID = 12312
DEVICE_TYPE = "temperature"

# 每个节点：(device_id, 房间名, 基准温度℃)
NODES = [
    (11924, "客厅",   26.0),
    (11923, "主卧",   26.5),
    (11922, "次卧",   25.8),
    (11921, "书房",   26.2),
    (11920, "厨房",   27.5),
    (11919, "卫生间", 27.0),
    (11918, "阳台",   29.0),
    (11917, "儿童房", 26.0),   # 原清单中的 node_1192217，见文件头说明
]


class Node:
    """单个节点的温湿度/电量/信号模拟状态（随机游走，贴近真实缓慢变化）。"""

    def __init__(self, device_id, name, base_temp):
        self.device_id = device_id
        self.name = name
        self.base_temp = base_temp
        self.temp = base_temp + random.uniform(-0.3, 0.3)
        self.battery = random.uniform(3.28, 3.55)   # 起始电压(V)，随时间缓慢下降
        self.rssi = random.uniform(-78, -52)

    def sample(self):
        # 温度：围绕基准温做小步随机游走（夏季空调房 25~28℃ 附近）
        self.temp += random.gauss(0, 0.05)
        self.temp = max(self.base_temp - 1.2, min(self.base_temp + 1.2, self.temp))

        # 湿度：与温度大致负相关，小幅波动
        humidity = 58.0 - (self.temp - self.base_temp) * 2.5 + random.gauss(0, 1.5)
        humidity = max(35, min(78, humidity))

        # 电量：每轮上报缓慢下降，偶尔小幅噪声
        self.battery -= random.uniform(0.0001, 0.0006)
        self.battery = max(2.80, self.battery)

        # 信号强度：BLE RSSI 随机游走
        self.rssi += random.gauss(0, 1.5)
        self.rssi = max(-88, min(-45, self.rssi))

        return {
            "name": self.name,
            "temperature": round(self.temp, 1),
            "humidity": int(round(humidity)),
            "battery": round(self.battery, 2),
            "rssi": int(round(self.rssi)),
        }


def build_client():
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"sim-home-{random.randint(1000, 9999)}",
        clean_session=True,
    )
    client.reconnect_delay_set(min_delay=1, max_delay=30)
    return client


def on_connect(client, userdata, flags, reason_code, properties):
    if reason_code == 0:
        print(f"[MQTT] 已连接 {BROKER_HOST}:{BROKER_PORT}")
    else:
        print(f"[MQTT] 连接失败，code={reason_code}")


def main():
    parser = argparse.ArgumentParser(description="模拟家庭温湿度节点 MQTT 上报")
    parser.add_argument("--interval", type=float, default=30.0, help="上报间隔（秒），默认 30")
    parser.add_argument("--once", action="store_true", help="只上报一轮后退出")
    parser.add_argument("--rounds", type=int, default=0, help="上报轮数，0=无限循环")
    parser.add_argument("--username", default="", help="MQTT 用户名（可选）")
    parser.add_argument("--password", default="", help="MQTT 密码（可选）")
    args = parser.parse_args()

    client = build_client()
    client.on_connect = on_connect
    if args.username:
        client.username_pw_set(args.username, args.password)

    print(f"[init] 目标 {BROKER_HOST}:{BROKER_PORT}，gateway_id={GATEWAY_ID}，节点 {len(NODES)} 个")
    try:
        client.connect(BROKER_HOST, BROKER_PORT, keepalive=60)
        client.loop_start()
    except Exception as exc:
        print(f"[错误] 无法连接 MQTT broker: {exc}")
        sys.exit(1)

    # 等待首次连接建立
    deadline = time.time() + 15
    while not client.is_connected() and time.time() < deadline:
        time.sleep(0.1)
    if not client.is_connected():
        print("[错误] 15s 内未连上 broker，请检查网络/端口。")
        sys.exit(1)

    nodes = [Node(*cfg) for cfg in NODES]
    try:
        rounds = 1 if args.once else args.rounds
        n = 0
        while rounds == 0 or n < rounds:
            n += 1
            for node in nodes:
                topic = f"gateway_{GATEWAY_ID}/node_{node.device_id}/{DEVICE_TYPE}"
                payload = json.dumps(node.sample(), ensure_ascii=False)
                client.publish(topic, payload, qos=0)
                print(f"[{n:>4}] {topic:40s} {payload}")
            print(f"  本轮完成，{args.interval:.0f}s 后下一轮（Ctrl+C 退出）")
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n[退出] 用户中断")
    finally:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
