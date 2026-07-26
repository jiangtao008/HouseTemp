#pragma once

#include <cstdint>

struct __attribute__((packed)) SensorPacket {
  uint8_t protocol_ver;
  uint16_t device_id;
  uint32_t counter;
  int16_t temperature;
  uint8_t humidity;
  uint16_t battery_mv;
  uint32_t auth_tag;
};

uint32_t calculate_auth_tag(const SensorPacket &packet);
bool ble_adv_start(const SensorPacket &packet, uint32_t duration_ms);
void ble_adv_stop();
