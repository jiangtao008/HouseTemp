#include "wifi_connect.h"

#include <Arduino.h>
#include <WiFi.h>

#include "config.h"

bool wifi_connect() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(gateway_config.wifi_ssid, gateway_config.wifi_password);

  for (int i = 0; i < 30; ++i) {
    if (WiFi.status() == WL_CONNECTED) {
      return true;
    }
    delay(500);
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
