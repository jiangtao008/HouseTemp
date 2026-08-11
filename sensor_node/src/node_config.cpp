#include "node_config.h"

#include <Arduino.h>
#include <Preferences.h>

#include <cstring>

#include "config.h"

namespace node_config {
namespace {
Preferences prefs;
uint16_t stored_device_id = DEFAULT_DEVICE_ID;
char stored_name[NODE_NAME_MAX_LEN + 1] = "Unnamed";
}  // namespace

void init() {
  if (!prefs.begin("node_cfg", false)) {
    // NVS 打开失败（极少见）：保留默认值继续运行。
    return;
  }

  const uint32_t id = prefs.getUInt("device_id", DEFAULT_DEVICE_ID);
  stored_device_id = (id > 0 && id <= 0xFFFF) ? static_cast<uint16_t>(id)
                                              : DEFAULT_DEVICE_ID;

  String n = prefs.getString("node_name", "Unnamed");
  if (n.isEmpty()) {
    stored_name[0] = '\0';
  } else {
    strncpy(stored_name, n.c_str(), NODE_NAME_MAX_LEN);
    stored_name[NODE_NAME_MAX_LEN] = '\0';
  }
  // 注意：这里不调用 prefs.end()。深睡会复位整颗芯片，唤醒后 init() 重新 begin 即可。
}

uint16_t device_id() { return stored_device_id; }

const char *name() { return stored_name; }

bool set_device_id(uint16_t id) {
  if (id == 0) {
    return false;
  }
  if (!prefs.putUInt("device_id", id)) {
    return false;
  }
  stored_device_id = id;
  return true;
}

bool set_name(const char *s) {
  if (s == nullptr || s[0] == '\0') {
    return false;
  }
  if (!prefs.putString("node_name", s)) {
    return false;
  }
  strncpy(stored_name, s, NODE_NAME_MAX_LEN);
  stored_name[NODE_NAME_MAX_LEN] = '\0';
  return true;
}

void clear() {
  prefs.remove("device_id");
  prefs.remove("node_name");
  stored_device_id = DEFAULT_DEVICE_ID;
  strncpy(stored_name, "Unnamed", NODE_NAME_MAX_LEN);
  stored_name[NODE_NAME_MAX_LEN] = '\0';
}

void print() {
  // 与配置模式的串口输出保持一致：两条串口都写。
  Serial.printf("device_id : %u\r\n", stored_device_id);
  Serial.printf("node_name : %s\r\n", stored_name);
  Serial0.printf("device_id : %u\r\n", stored_device_id);
  Serial0.printf("node_name : %s\r\n", stored_name);
}

}  // namespace node_config
