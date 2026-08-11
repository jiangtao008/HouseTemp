#pragma once

#include <cstdint>

// 节点运行时配置：持久化在 NVS（Preferences），由配置模式串口修改。
// 编译期默认值见 config.h（DEFAULT_DEVICE_ID / NODE_NAME_MAX_LEN）。
namespace node_config {

// 上电时调用一次，从 NVS 加载配置；不存在或校验失败时使用默认值。
void init();

uint16_t device_id();
const char *name();

// 校验值域并写入 NVS；成功返回 true。
bool set_device_id(uint16_t id);
bool set_name(const char *s);

// 清空 NVS 中的配置，恢复默认值。
void clear();

// 打印当前配置到 Serial / Serial0（供配置模式 banner 与 show 命令复用）。
void print();

}  // namespace node_config
