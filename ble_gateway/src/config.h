#pragma once

#include <Arduino.h>

constexpr uint8_t PROTOCOL_VERSION = 1;
constexpr size_t GATEWAY_NAME_MAX_LEN = 32;
constexpr size_t WIFI_SSID_MAX_LEN = 32;
constexpr size_t WIFI_PASSWORD_MAX_LEN = 64;
constexpr size_t MQTT_HOST_MAX_LEN = 64;
constexpr size_t MQTT_USERNAME_MAX_LEN = 32;
constexpr size_t MQTT_PASSWORD_MAX_LEN = 64;
constexpr size_t AUTH_KEY_BYTES = 16;
constexpr size_t AUTH_KEY_HEX_LEN = AUTH_KEY_BYTES * 2;

struct GatewayConfig {
  char gateway_name[GATEWAY_NAME_MAX_LEN + 1];
  char wifi_ssid[WIFI_SSID_MAX_LEN + 1];
  char wifi_password[WIFI_PASSWORD_MAX_LEN + 1];
  char mqtt_host[MQTT_HOST_MAX_LEN + 1];
  uint16_t mqtt_port;
  char mqtt_username[MQTT_USERNAME_MAX_LEN + 1];
  char mqtt_password[MQTT_PASSWORD_MAX_LEN + 1];
  uint8_t auth_key[AUTH_KEY_BYTES];
};

extern GatewayConfig gateway_config;

void config_set_defaults(GatewayConfig &config);
bool config_load();
bool config_save(const GatewayConfig &config);

constexpr uint8_t DISPLAY_WIDTH = 240;
constexpr uint16_t DISPLAY_HEIGHT = 320;
constexpr uint8_t TFT_CS_PIN = 10;
constexpr uint8_t TFT_DC_PIN = 8;
constexpr uint8_t TFT_RST_PIN = 9;
constexpr uint8_t TFT_SCLK_PIN = 12;
constexpr uint8_t TFT_MOSI_PIN = 11;
constexpr int8_t TFT_MISO_PIN = -1;
constexpr uint8_t TFT_BACKLIGHT_PIN = 7;
constexpr uint8_t TAB_BUTTON_PIN = 14;
constexpr uint32_t DISPLAY_REFRESH_MS = 500;
constexpr size_t MAX_DISPLAY_NODES = 8;

struct NodeNameConfig {
  uint16_t device_id;
  const char *name;
};

constexpr NodeNameConfig NODE_NAMES[] = {
    {10001, "Node-1"},
};
constexpr size_t NODE_NAME_COUNT = sizeof(NODE_NAMES) / sizeof(NODE_NAMES[0]);

constexpr uint8_t DEFAULT_AUTH_KEY[AUTH_KEY_BYTES] = {
    0x42, 0x19, 0xA7, 0x5C, 0xE1, 0x33, 0x90, 0x6D,
    0x28, 0xF4, 0x77, 0x0B, 0xC8, 0x5A, 0x11, 0x9E,
};
