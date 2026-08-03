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

bool mqtt_connect() {
  mqtt_client.setServer(gateway_config.mqtt_host, gateway_config.mqtt_port);

  if (mqtt_client.connected()) {
    return true;
  }

  String client_id = "esp32-c3-gw-";
  client_id += String((uint32_t)ESP.getEfuseMac(), HEX);

  bool ok = false;
  if (strlen(gateway_config.mqtt_username) > 0) {
    ok = mqtt_client.connect(client_id.c_str(), gateway_config.mqtt_username,
                             gateway_config.mqtt_password);
  } else {
    ok = mqtt_client.connect(client_id.c_str());
  }

  return ok;
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
