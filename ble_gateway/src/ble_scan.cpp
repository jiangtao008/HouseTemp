#include <cstddef>
#include <cstring>

#include "ble_scan.h"

#include <mbedtls/md.h>

#include "config.h"

namespace {

struct DeviceCounterState {
  uint16_t device_id;
  uint32_t last_counter;
  bool used;
};

constexpr size_t kMaxTrackedDevices = 16;
DeviceCounterState counter_states[kMaxTrackedDevices] = {};

uint32_t calculate_auth_tag(const SensorPacket &packet) {
  unsigned char digest[32] = {0};
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr) {
    return 0;
  }

  const int rc = mbedtls_md_hmac(info, gateway_config.auth_key,
                                 sizeof(gateway_config.auth_key),
                                 reinterpret_cast<const unsigned char *>(&packet),
                                 offsetof(SensorPacket, auth_tag), digest);
  if (rc != 0) {
    return 0;
  }

  uint32_t tag = 0;
  memcpy(&tag, digest, sizeof(tag));
  return tag;
}

}  // namespace

bool parse_sensor_packet(const std::string &data, SensorPacket &packet) {
  if (data.size() != sizeof(SensorPacket)) {
    return false;
  }

  memcpy(&packet, data.data(), sizeof(SensorPacket));
  return true;
}

bool verify_sensor_packet(const SensorPacket &packet) {
  if (packet.protocol_ver != PROTOCOL_VERSION) {
    return false;
  }

  SensorPacket expected = packet;
  expected.auth_tag = 0;
  return calculate_auth_tag(expected) == packet.auth_tag;
}

bool accept_packet_counter(uint16_t device_id, uint32_t counter) {
  for (auto &state : counter_states) {
    if (!state.used) {
      continue;
    }
    if (state.device_id != device_id) {
      continue;
    }
    if (counter <= state.last_counter) {
      return false;
    }
    state.last_counter = counter;
    return true;
  }

  for (auto &state : counter_states) {
    if (state.used) {
      continue;
    }
    state.used = true;
    state.device_id = device_id;
    state.last_counter = counter;
    return true;
  }

  return false;
}
