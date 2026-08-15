#pragma once

#include <Arduino.h>

// 冷启动进入的配置模式：上报当前配置并等待串口命令。
//   - idle_timeout_ms 内没有收到任何命令 → 返回，调用方继续正常低功耗流程
//   - 收到任意命令后 → 取消超时，一直保持配置模式，直到 reboot 或下次冷启动
void enter_config_mode(uint32_t idle_timeout_ms);
