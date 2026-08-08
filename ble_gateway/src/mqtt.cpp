#include "mqtt.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <cstring>

#include "config.h"
#include "node_registry.h"
#include "status.h"

namespace {
WiFiClient wifi_client;
PubSubClient mqtt_client(wifi_client);
}  // namespace

// 重连尝试的最小间隔。connect() 同步阻塞（broker 不可达时最长到 socket 超时），
// 加节流后断网时 loop() 不会被每个周期都拖住，显示屏 5s 自动切页保持正常。
constexpr uint32_t kMqttReconnectIntervalMs = 5000;

bool mqtt_connect() {
  // WiFi 未连接时 MQTT 无意义；在这里拦下也避免在 WiFi 掉线时被死 broker
  // 的 socket 超时卡住 loop()（从而拖慢显示屏的 5s 自动切页），并清理链路
  // 断开后遗留的 TCP 状态——否则 connected() 会保持 stale-true，publish 会
  // 打到已失效的 socket。
  if (!wifi_is_connected()) {
    if (mqtt_client.connected()) {
      mqtt_client.disconnect();
    }
    return false;
  }

  if (mqtt_client.connected()) {
    return true;
  }

  // connect() 是同步的，broker 不可达时会阻塞到 socket 超时。5 s 对健康的
  // CONNACK（通常 <1 s）足够，且能约束 broker 掉线时的停顿；再叠加下面的
  // 5 s 重连节流，使其至多每 5 s 窗口阻塞一次，而不是每轮 loop() 都阻塞。
  // 节流 static 为函数级，被 loop/setup/mqtt_publish_sensor 共享：传感器触发
  // 的连接尝试占用同一个名额，不会因 BLE 报文洪泛而触发一连串阻塞 connect。
  static uint32_t last_attempt_ms = 0;  // 0 = 尚未尝试过
  const uint32_t now = millis();
  const bool first = (last_attempt_ms == 0 && now > 0);
  if (!first && (now - last_attempt_ms < kMqttReconnectIntervalMs)) {
    return mqtt_client.connected();
  }
  last_attempt_ms = now;

  mqtt_client.setServer(gateway_config.mqtt_host, gateway_config.mqtt_port);
  mqtt_client.setSocketTimeout(5);

  String client_id = "esp32-c3-gw-";
  client_id += String((uint32_t)ESP.getEfuseMac(), HEX);

  if (strlen(gateway_config.mqtt_username) > 0) {
    return mqtt_client.connect(client_id.c_str(), gateway_config.mqtt_username,
                               gateway_config.mqtt_password);
  }
  return mqtt_client.connect(client_id.c_str());
}

bool mqtt_publish_sensor(uint16_t device_id, float temperature, uint8_t humidity, float battery_v, int rssi) {
  if (!mqtt_client.connected() && !mqtt_connect()) {
    return false;
  }

  // 分级主题：gateway_<网关id>/node_<节点id>/<设备类型>
  char topic[96];
  snprintf(topic, sizeof(topic), "gateway_%lu/node_%u/%s",
           (unsigned long)gateway_config.gateway_id, device_id, kSensorType);

  StaticJsonDocument<256> doc;
  doc["id"] = device_id;
  doc["name"] = node_name_for_id(device_id);
  doc["temperature"] = temperature;
  doc["humidity"] = humidity;
  doc["battery"] = battery_v;
  doc["rssi"] = rssi;

  char payload[192];
  size_t len = serializeJson(doc, payload, sizeof(payload));
  return mqtt_client.publish(topic, payload, len);
}

void mqtt_loop() {
  mqtt_client.loop();
}

bool mqtt_is_connected() {
  return mqtt_client.connected();
}
