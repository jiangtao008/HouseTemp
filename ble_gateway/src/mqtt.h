#pragma once

#include <cstdint>

bool mqtt_connect();
bool mqtt_publish_sensor(uint16_t device_id, float temperature, uint8_t humidity, float battery_v, int rssi);
void mqtt_loop();
