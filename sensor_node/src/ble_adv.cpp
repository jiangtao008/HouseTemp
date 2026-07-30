#include "ble_adv.h"

#include <cstddef>
#include <cstring>

#include <NimBLEDevice.h>
#include <mbedtls/md.h>

#include "config.h"

namespace {
NimBLEAdvertising *advertising = nullptr;
}  // namespace

uint32_t calculate_auth_tag(const SensorPacket &packet) {
  SensorPacket expected = packet;
  expected.auth_tag = 0;
  unsigned char digest[32] = {0};
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr) {
    return 0;
  }

  const int rc = mbedtls_md_hmac(info, AUTH_KEY, sizeof(AUTH_KEY),
                                 reinterpret_cast<const unsigned char *>(&expected),
                                 offsetof(SensorPacket, auth_tag), digest);
  if (rc != 0) {
    return 0;
  }

  uint32_t tag = 0;
  memcpy(&tag, digest, sizeof(tag));
  return tag;
}

bool ble_adv_start(const SensorPacket &packet, uint32_t duration_ms) {
  if (!advertising) {
    NimBLEDevice::init("");
    NimBLEDevice::setPower(ESP_PWR_LVL_P3);
    advertising = NimBLEDevice::getAdvertising();
    advertising->setConnectableMode(BLE_GAP_CONN_MODE_NON);
  }

  NimBLEAdvertisementData data;
  data.setFlags(0x06);
  data.setManufacturerData(
      std::string(reinterpret_cast<const char *>(&packet), sizeof(packet)));

  advertising->stop();
  advertising->setAdvertisementData(data);
  advertising->start(duration_ms);
  return true;
}

void ble_adv_stop() {
  if (advertising) {
    advertising->stop();
  }
  NimBLEDevice::deinit(true);
  advertising = nullptr;
}
