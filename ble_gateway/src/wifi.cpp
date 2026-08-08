#include "wifi_connect.h"

#include <Arduino.h>
#include <WiFi.h>

#include "config.h"

// 重新发起 WiFi.begin() 的最小间隔。begin() 本身异步，连接在后台进行，
// 这里仅限流，避免断网时每轮 loop() 都重置一次连接尝试。
constexpr uint32_t kWifiBeginIntervalMs = 3000;

bool wifi_connect() {
  if (WiFi.status() == WL_CONNECTED) {
    return true;  // 已关联就不再重复 begin()，避免重置链路
  }

  // ESP32 上 WiFi.begin() 是异步的——不要轮询等待 WL_CONNECTED（断网时会
  // 阻塞 loop() 最多 15s，导致显示屏 5s 自动切页被拖成十几秒一次）。
  // 至多每 3s 重新发起一次 begin()，立即返回当前链路状态，连接在后台进行。
  static uint32_t last_begin_ms = 0;  // 0 = 尚未发起过
  const uint32_t now = millis();
  const bool first = (last_begin_ms == 0 && now > 0);
  if (first || (now - last_begin_ms >= kWifiBeginIntervalMs)) {
    last_begin_ms = now;
    WiFi.mode(WIFI_STA);
    WiFi.begin(gateway_config.wifi_ssid, gateway_config.wifi_password);
  }

  return WiFi.status() == WL_CONNECTED;
}

bool wifi_is_connected() {
  return WiFi.status() == WL_CONNECTED;
}

const char *wifi_ip_string() {
  static char ip[24];
  snprintf(ip, sizeof(ip), "%s", WiFi.localIP().toString().c_str());
  return ip;
}

int wifi_signal_rssi() {
  return wifi_is_connected() ? WiFi.RSSI() : 0;
}
