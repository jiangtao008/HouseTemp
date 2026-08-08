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
bool accept_sensor_report(uint16_t device_id);

// Packet as handed from the BLE scan callback to the main loop.
struct QueuedSensorPacket {
  SensorPacket packet;
  int rssi;
};

// Push/pop a small single-producer/single-consumer queue. The BLE scan
// callback (runs in the NimBLE host task) only enqueues here — it must never
// touch LVGL or PubSubClient directly, since neither is thread-safe. The main
// loop drains the queue and does the display + MQTT work on one task.
bool enqueue_sensor_packet(const SensorPacket &packet, int rssi);
bool dequeue_sensor_packet(QueuedSensorPacket &entry);
