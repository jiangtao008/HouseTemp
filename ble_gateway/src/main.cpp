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
#include <esp_system.h>
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
    if (!accept_sensor_report(packet.device_id)) {
      return;
    }

    // Hand the packet to the main loop. Never touch the display or MQTT from
    // this callback — it runs in the NimBLE host task, while the Arduino loop
    // task is also using them. LVGL and PubSubClient are not thread-safe, so
    // all display + MQTT work happens single-threaded in loop().
    enqueue_sensor_packet(packet, device->getRSSI());
  }
};

static SensorScanCallback scan_callback;

// ESP-IDF in this Arduino core has esp_reset_reason() but no string mapper,
// so keep a small lookup here for the boot log.
static const char *reset_reason_str(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON:   return "power-on";
    case ESP_RST_EXT:       return "external pin";
    case ESP_RST_SW:        return "software restart (esp_restart)";
    case ESP_RST_PANIC:     return "PANIC / exception / abort";
    case ESP_RST_INT_WDT:   return "interrupt watchdog";
    case ESP_RST_TASK_WDT:  return "task watchdog timeout";
    case ESP_RST_WDT:       return "watchdog";
    case ESP_RST_DEEPSLEEP: return "deep-sleep wake";
    case ESP_RST_BROWNOUT:  return "brownout (power dip)";
    case ESP_RST_SDIO:      return "sdio";
    default:                return "unknown";
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);

  // Record why we booted: if the gateway keeps restarting, this tells us
  // whether it was a panic (Guru Meditation / abort), a task watchdog, or a
  // brownout. Also log free heap so leaks are visible across reboots.
  Serial.printf("[boot] reset reason: %s | free heap: %u bytes | psram: %s\n",
                reset_reason_str(esp_reset_reason()), ESP.getFreeHeap(),
                psramFound() ? "yes" : "no");

  config_load();

  // Let the host know the gateway is up (confirms a serial "reboot" completed).
  serial_config_notify_boot();

  display_init();

  // 网关 ID 由网关页的独立"ID"行展示（见 display.cpp build_gateway_tab），
  // 此处仅显示名称，避免与 ID 行重复。
  display_set_gateway_name(gateway_config.gateway_name);

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

  // Drain the BLE queue on the main task (the scan callback only enqueues —
  // see SensorScanCallback::onResult). This keeps LVGL and PubSubClient
  // single-threaded, and moves any display/MQTT work out of the NimBLE host
  // task. The display updates even while the network is down.
  QueuedSensorPacket entry;
  while (dequeue_sensor_packet(entry)) {
    const float temperature = entry.packet.temperature / 100.0f;
    const float battery_v = entry.packet.battery_mv / 1000.0f;

    DisplayNodeData node_data{};
    node_data.device_id = entry.packet.device_id;
    node_data.temperature = temperature;
    node_data.humidity = entry.packet.humidity;
    node_data.battery_mv = entry.packet.battery_mv;
    node_data.rssi = entry.rssi;
    node_data.counter = entry.packet.counter;
    node_data.last_seen_ms = millis();
    display_upsert_node(node_data);

    // Publish only over a live link. The wifi_is_connected() guard covers the
    // window where mqtt_client.connected() is still stale-true after the link
    // dropped, so we never publish into a dead socket.
    if (mqtt_is_connected() && wifi_is_connected()) {
      mqtt_publish_sensor(entry.packet.device_id, temperature,
                          entry.packet.humidity, battery_v, entry.rssi);
    }
  }

  // Non-blocking network maintenance: wifi_connect() returns immediately
  // (async begin, throttled to 3 s), and mqtt_connect() never runs while WiFi
  // is down and is otherwise throttled to one ≤5 s socket-timeout stall per
  // 5 s window. Either way loop() stays a tight ~10 ms cycle, so the display
  // refreshes on schedule even when the network is down.
  wifi_connect();
  if (wifi_is_connected()) {
    mqtt_connect();
    if (mqtt_is_connected()) {
      mqtt_loop();
    }
  }

  display_set_gateway_status(wifi_is_connected(), mqtt_is_connected());
  display_set_gateway_network(wifi_ip_string(), wifi_signal_rssi());
  delay(10);
}

#endif  // RUN_LVGL_TEST
