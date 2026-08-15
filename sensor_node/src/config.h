#pragma once

#include <Arduino.h>

// 编译期默认节点 ID。运行时可通过配置模式（冷启动 5s 窗口内串口命令）覆盖，并持久化到 NVS。
constexpr uint16_t DEFAULT_DEVICE_ID = 10009;
constexpr uint8_t PROTOCOL_VERSION = 1;
constexpr uint8_t I2C_SDA_PIN = 4;
constexpr uint8_t I2C_SCL_PIN = 5;
constexpr uint32_t SAMPLE_INTERVAL_SEC = 60;
constexpr uint32_t ADVERTISE_DURATION_MS = 1500;

// 冷启动进入配置模式的等待窗口：5s 内收到任意串口命令则一直保持配置模式（直到下次冷启动），
// 超时无命令则退出配置模式，进入正常低功耗流程。
constexpr uint32_t CONFIG_MODE_WINDOW_MS = 5000;
constexpr uint8_t NODE_NAME_MAX_LEN = 32;

// Set to a valid ADC pin if you want real battery measurement.
constexpr int BATTERY_ADC_PIN = -1;

// Replace this with your own random key and keep gateway/node consistent.
constexpr uint8_t AUTH_KEY[] = {
    0x42, 0x19, 0xA7, 0x5C, 0xE1, 0x33, 0x90, 0x6D,
    0x28, 0xF4, 0x77, 0x0B, 0xC8, 0x5A, 0x11, 0x9E,
};
