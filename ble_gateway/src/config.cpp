#include "config.h"

#include <Preferences.h>

#include <cstring>

namespace {

constexpr char kNamespace[] = "gateway_config";
constexpr char kDefaultWifiSsid[] = "住满一年再搬家";
constexpr char kDefaultWifiPassword[] = "jt520txy";
constexpr char kDefaultMqttHost[] = "192.168.1.10";
constexpr char kDefaultGatewayName[] = "全屋温湿度网关";

void copy_string(char *destination, size_t capacity, const char *source) {
  if (capacity == 0) {
    return;
  }
  snprintf(destination, capacity, "%s", source == nullptr ? "" : source);
}

bool put_string(Preferences &preferences, const char *key, const char *value) {
  return preferences.putString(key, value) > 0 || value[0] == '\0';
}

}  // namespace

GatewayConfig gateway_config = {};

void config_set_defaults(GatewayConfig &config) {
  memset(&config, 0, sizeof(config));
  copy_string(config.gateway_name, sizeof(config.gateway_name), kDefaultGatewayName);
  copy_string(config.wifi_ssid, sizeof(config.wifi_ssid), kDefaultWifiSsid);
  copy_string(config.wifi_password, sizeof(config.wifi_password), kDefaultWifiPassword);
  copy_string(config.mqtt_host, sizeof(config.mqtt_host), kDefaultMqttHost);
  config.mqtt_port = 1883;
  memcpy(config.auth_key, DEFAULT_AUTH_KEY, sizeof(config.auth_key));
}

bool config_load() {
  config_set_defaults(gateway_config);

  Preferences preferences;
  if (!preferences.begin(kNamespace, true)) {
    return false;
  }

  const bool initialized = preferences.getBool("initialized", false);
  if (!initialized) {
    preferences.end();
    return config_save(gateway_config);
  }

  String value = preferences.getString("gw_name", gateway_config.gateway_name);
  copy_string(gateway_config.gateway_name, sizeof(gateway_config.gateway_name), value.c_str());
  value = preferences.getString("wifi_ssid", gateway_config.wifi_ssid);
  copy_string(gateway_config.wifi_ssid, sizeof(gateway_config.wifi_ssid), value.c_str());
  value = preferences.getString("wifi_pass", gateway_config.wifi_password);
  copy_string(gateway_config.wifi_password, sizeof(gateway_config.wifi_password), value.c_str());
  value = preferences.getString("mqtt_host", gateway_config.mqtt_host);
  copy_string(gateway_config.mqtt_host, sizeof(gateway_config.mqtt_host), value.c_str());
  gateway_config.mqtt_port = preferences.getUShort("mqtt_port", gateway_config.mqtt_port);
  value = preferences.getString("mqtt_user", gateway_config.mqtt_username);
  copy_string(gateway_config.mqtt_username, sizeof(gateway_config.mqtt_username), value.c_str());
  value = preferences.getString("mqtt_pass", gateway_config.mqtt_password);
  copy_string(gateway_config.mqtt_password, sizeof(gateway_config.mqtt_password), value.c_str());

  if (preferences.getBytesLength("auth_key") == sizeof(gateway_config.auth_key)) {
    preferences.getBytes("auth_key", gateway_config.auth_key, sizeof(gateway_config.auth_key));
  }

  preferences.end();
  if (gateway_config.mqtt_port == 0) {
    gateway_config.mqtt_port = 1883;
  }
  return true;
}

bool config_save(const GatewayConfig &config) {
  Preferences preferences;
  if (!preferences.begin(kNamespace, false)) {
    return false;
  }

  bool ok = true;
  ok = put_string(preferences, "gw_name", config.gateway_name) && ok;
  ok = put_string(preferences, "wifi_ssid", config.wifi_ssid) && ok;
  ok = put_string(preferences, "wifi_pass", config.wifi_password) && ok;
  ok = put_string(preferences, "mqtt_host", config.mqtt_host) && ok;
  ok = preferences.putUShort("mqtt_port", config.mqtt_port) > 0 && ok;
  ok = put_string(preferences, "mqtt_user", config.mqtt_username) && ok;
  ok = put_string(preferences, "mqtt_pass", config.mqtt_password) && ok;
  ok = preferences.putBytes("auth_key", config.auth_key, sizeof(config.auth_key)) ==
           sizeof(config.auth_key) &&
       ok;
  if (ok) {
    ok = preferences.putBool("initialized", true) && ok;
  }

  preferences.end();
  return ok;
}
