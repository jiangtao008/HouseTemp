#pragma once

#include <Arduino.h>

// 编译期默认节点 ID。运行时可通过配置模式（CONFIG_IO_PIN 高电平 + 串口）覆盖，并持久化到 NVS。
constexpr uint16_t DEFAULT_DEVICE_ID = 10008;
constexpr uint8_t PROTOCOL_VERSION = 1;
constexpr uint8_t I2C_SDA_PIN = 4;
constexpr uint8_t I2C_SCL_PIN = 5;
constexpr uint32_t SAMPLE_INTERVAL_SEC = 60;
constexpr uint32_t ADVERTISE_DURATION_MS = 3000;

// 配置模式检测 IO：内部下拉，悬空=低电平=正常低功耗模式；短接 3.3V=高电平=进入非低功耗串口配置模式。
// 低电平（默认）同时把该引脚在深睡期间钳位为低，避免悬空。
constexpr uint8_t CONFIG_IO_PIN = 3;
constexpr uint8_t NODE_NAME_MAX_LEN = 32;

// Set to a valid ADC pin if you want real battery measurement.
constexpr int BATTERY_ADC_PIN = -1;

// Replace this with your own random key and keep gateway/node consistent.
constexpr uint8_t AUTH_KEY[] = {
    0x42, 0x19, 0xA7, 0x5C, 0xE1, 0x33, 0x90, 0x6D,
    0x28, 0xF4, 0x77, 0x0B, 0xC8, 0x5A, 0x11, 0x9E,
};
