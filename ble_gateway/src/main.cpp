// ── Select test mode: set only ONE to 1 ──
#define RUN_RAW_LVGL  0   // 裸 SPI + LVGL 测试
#define RUN_SPI_DIAG   0   // 裸 SPI 诊断
#define RUN_LVGL_TEST  0   // TFT_eSPI + LVGL 测试

#if RUN_RAW_LVGL

#include "raw_lvgl.h"
void setup() { raw_lvgl_main(); }
void loop()  { raw_lvgl_loop(); }

#elif RUN_SPI_DIAG

#include "spi_diag.h"
void setup() { spi_diagnostic(); }
void loop()  { loop_idle(); }

#elif RUN_LVGL_TEST

// ── Minimal LVGL + TFT test ──────────────────────────────────────────────
#include "test_lvgl.h"

void setup()  { test_lvgl_main(); }
void loop()   { test_lvgl_loop(); }

#else

// ── Normal application code ──────────────────────────────────────────────
#include <Arduino.h>
#include <NimBLEDevice.h>

#include "ble_scan.h"
#include "config.h"
#include "display.h"
#include "mqtt.h"
#include "serial_config.h"
#include "status.h"
#include "wifi_connect.h"

class SensorScanCallback : public NimBLEScanCallbacks {
 public:
  void onResult(const NimBLEAdvertisedDevice *device) override {
    if (!device->haveManufacturerData()) {
      return;
    }

    SensorPacket packet{};
    const std::string data = device->getManufacturerData();
    if (!parse_sensor_packet(data, packet)) {
      return;
    }
    if (!verify_sensor_packet(packet)) {
      return;
    }
    if (!accept_packet_counter(packet.device_id, packet.counter)) {
      return;
    }

    const float temperature = packet.temperature / 100.0f;
    const float battery_v = packet.battery_mv / 1000.0f;

    DisplayNodeData node_data{};
    node_data.device_id = packet.device_id;
    node_data.temperature = temperature;
    node_data.humidity = packet.humidity;
    node_data.battery_mv = packet.battery_mv;
    node_data.rssi = device->getRSSI();
    node_data.counter = packet.counter;
    node_data.last_seen_ms = millis();
    display_upsert_node(node_data);

    mqtt_publish_sensor(packet.device_id, temperature, packet.humidity, battery_v, device->getRSSI());
  }
};

static SensorScanCallback scan_callback;

void setup() {
  Serial.begin(115200);
  delay(200);

  config_load();

  // Let the host know the gateway is up (confirms a serial "reboot" completed).
  serial_config_notify_boot();

  display_init();

  // Show gateway name + id on screen（id 即 MQTT 主题中的 gateway_<id>）
  char gateway_label[64];
  snprintf(gateway_label, sizeof(gateway_label), "%s #%lu",
           gateway_config.gateway_name, (unsigned long)gateway_config.gateway_id);
  display_set_gateway_name(gateway_label);

  // Refresh display before the potentially-long blocking operations
  // that follow, so the user sees the initial UI immediately.
  display_update();

  wifi_connect();
  mqtt_connect();

  // Refresh again now that WiFi and MQTT status are known
  display_set_gateway_status(wifi_is_connected(), mqtt_is_connected());
  display_set_gateway_network(wifi_ip_string(), wifi_signal_rssi());
  display_update();

  NimBLEDevice::init("");
  NimBLEScan *scan = NimBLEDevice::getScan();
  scan->setScanCallbacks(&scan_callback, true);
  scan->setMaxResults(0);
  scan->setActiveScan(false);
  scan->setInterval(45);
  scan->setWindow(15);
  scan->start(0, false);
}

void loop() {
  serial_config_update();
  display_update();

  if (!wifi_is_connected()) {
    wifi_connect();
  }
  if (!mqtt_connect()) {
    display_set_gateway_status(wifi_is_connected(), false);
    display_set_gateway_network(wifi_ip_string(), wifi_signal_rssi());
    display_update();
    delay(1000);
    return;
  }

  display_set_gateway_status(wifi_is_connected(), mqtt_is_connected());
  display_set_gateway_network(wifi_ip_string(), wifi_signal_rssi());
  display_update();
  mqtt_loop();
  delay(10);
}

#endif  // RUN_LVGL_TEST
