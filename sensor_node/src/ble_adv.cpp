#include "ble_adv.h"

#include <cstddef>
#include <cstring>

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <esp_bt.h>
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
    if (!NimBLEDevice::init("")) {
      Serial.println("[ble] NimBLEDevice::init FAILED");
      return false;
    }
    NimBLEDevice::setPower(ESP_PWR_LVL_P3);
    advertising = NimBLEDevice::getAdvertising();
    if (advertising == nullptr) {
      Serial.println("[ble] getAdvertising() returned null");
      return false;
    }
    advertising->setConnectableMode(BLE_GAP_CONN_MODE_NON);
  }

  NimBLEAdvertisementData data;
  data.setFlags(0x06);
  data.setManufacturerData(
      std::string(reinterpret_cast<const char *>(&packet), sizeof(packet)));

  advertising->stop();
  advertising->setAdvertisementData(data);
  if (!advertising->start(duration_ms)) {
    Serial.println("[ble] advertising start FAILED (host not synced?)");
    return false;
  }
  return true;
}

void ble_adv_stop() {
  if (advertising) {
    advertising->stop();
  }

  // 注意：不调用 NimBLEDevice::deinit()。深睡会复位整颗芯片，BLE 状态无需保留；
  // 而 deinit() 内部的 nimble_port_stop() 会永久等待，一旦卡住，整个节点就停在
  // setup() 里不再上报——正是“发了一次数据后再没消息”的典型表现。
  // 这里只停掉 BT 控制器、关掉射频，随后即可安全入睡。
  delay(100);  // 等 advertising 真正停掉，避免与控制器关闭竞争
  if (esp_bt_controller_get_status() == ESP_BT_CONTROLLER_STATUS_ENABLED) {
    esp_bt_controller_disable();
  }
  delay(50);  // 给射频停稳留一点时间
  advertising = nullptr;
}
