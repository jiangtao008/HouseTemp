#pragma once

#include <cstdint>

struct DisplayNodeData {
  uint16_t device_id;
  float temperature;
  uint8_t humidity;
  uint16_t battery_mv;
  int rssi;
  uint32_t counter;
  uint32_t last_seen_ms;
};

bool display_init();
void display_update();
void display_set_gateway_name(const char *name);
void display_set_gateway_status(bool wifi_ok, bool mqtt_ok);
void display_set_gateway_network(const char *ip, int wifi_rssi);
void display_upsert_node(const DisplayNodeData &node);

