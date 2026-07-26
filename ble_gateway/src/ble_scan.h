#pragma once

#include <cstdint>
#include <string>

struct __attribute__((packed)) SensorPacket {
  uint8_t protocol_ver;
  uint16_t device_id;
  uint32_t counter;
  int16_t temperature;
  uint8_t humidity;
  uint16_t battery_mv;
  uint32_t auth_tag;
};

bool parse_sensor_packet(const std::string &data, SensorPacket &packet);
bool verify_sensor_packet(const SensorPacket &packet);
bool accept_packet_counter(uint16_t device_id, uint32_t counter);
