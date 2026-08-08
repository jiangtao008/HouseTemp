#pragma once

#include <Arduino.h>

constexpr uint16_t DEVICE_ID = 10008;
constexpr uint8_t PROTOCOL_VERSION = 1;
constexpr uint8_t I2C_SDA_PIN = 4;
constexpr uint8_t I2C_SCL_PIN = 5;
constexpr uint32_t SAMPLE_INTERVAL_SEC = 60;
constexpr uint32_t ADVERTISE_DURATION_MS = 3000;

// Set to a valid ADC pin if you want real battery measurement.
constexpr int BATTERY_ADC_PIN = -1;

// Replace this with your own random key and keep gateway/node consistent.
constexpr uint8_t AUTH_KEY[] = {
    0x42, 0x19, 0xA7, 0x5C, 0xE1, 0x33, 0x90, 0x6D,
    0x28, 0xF4, 0x77, 0x0B, 0xC8, 0x5A, 0x11, 0x9E,
};
