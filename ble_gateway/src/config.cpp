#include "config.h"

#include <Preferences.h>
#include <esp_mac.h>

#include <cstring>

namespace {

constexpr char kNamespace[] = "gateway_config";
constexpr char kDefaultWifiSsid[] = "住满一年再搬家";
constexpr char kDefaultWifiPassword[] = "jt520txy";
constexpr char kDefaultMqttHost[] = "118.89.133.140";
constexpr uint16_t kDefaultMqttPort = 9883;
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

// 网关 ID 未配置（0=未设置）时，从芯片出厂 MAC 的后 3 字节派生一个稳定 ID。
// 该字节段对同一芯片恒定、且同一网段内不同设备不重复，天然满足
// MQTT 主题 gateway_<id>/... 需要"唯一且稳定"的要求。24 位取值 1~16777215，
// 落在串口校验范围 1~99999999 内，用户仍可随时用 set gateway.id 覆盖。
uint32_t derive_gateway_id() {
  uint8_t mac[6] = {0};
  esp_efuse_mac_get_default(mac);
  uint32_t id = (static_cast<uint32_t>(mac[3]) << 16) |
                (static_cast<uint32_t>(mac[4]) << 8) |
                static_cast<uint32_t>(mac[5]);
  return (id == 0) ? 1 : id;
}

}  // namespace

GatewayConfig gateway_config = {};

void config_set_defaults(GatewayConfig &config) {
  memset(&config, 0, sizeof(config));
  config.gateway_id = 0;
  copy_string(config.gateway_name, sizeof(config.gateway_name), kDefaultGatewayName);
  copy_string(config.wifi_ssid, sizeof(config.wifi_ssid), kDefaultWifiSsid);
  copy_string(config.wifi_password, sizeof(config.wifi_password), kDefaultWifiPassword);
  copy_string(config.mqtt_host, sizeof(config.mqtt_host), kDefaultMqttHost);
  config.mqtt_port = kDefaultMqttPort;
  memcpy(config.auth_key, DEFAULT_AUTH_KEY, sizeof(config.auth_key));
}

bool config_load() {
  config_set_defaults(gateway_config);

  // 以读写方式打开：NVS 首次初始化（被擦除/全新）时命名空间尚不存在，
  // 只读 open 会返回 NOT_FOUND 导致加载失败；读写 open 会创建命名空间。
  Preferences preferences;
  if (!preferences.begin(kNamespace, false)) {
    return false;
  }

  const bool initialized = preferences.getBool("initialized", false);
  if (!initialized) {
    preferences.end();
    // 首次初始化：未设置网关 ID 时派生一个稳定 ID 一并持久化，
    // 避免首次启动就显示 0。
    if (gateway_config.gateway_id == 0) {
      gateway_config.gateway_id = derive_gateway_id();
    }
    return config_save(gateway_config);
  }

  gateway_config.gateway_id = preferences.getUInt("gw_id", gateway_config.gateway_id);
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
    gateway_config.mqtt_port = kDefaultMqttPort;
  }

  // 网关 ID 未设置（旧固件未持久化 gw_id，或从未配置）时，
  // 从 MAC 派生稳定 ID 并持久化，保证网关页与 MQTT 主题有真实 ID。
  if (gateway_config.gateway_id == 0) {
    gateway_config.gateway_id = derive_gateway_id();
    config_save(gateway_config);
  }
  return true;
}

bool config_save(const GatewayConfig &config) {
  Preferences preferences;
  if (!preferences.begin(kNamespace, false)) {
    return false;
  }

  bool ok = true;
  ok = preferences.putUInt("gw_id", config.gateway_id) > 0 && ok;
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
