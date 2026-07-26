#include <Arduino.h>
#include <esp_sleep.h>

#include "config.h"

uint16_t read_battery_mv() {
  if (BATTERY_ADC_PIN < 0) {
    return 0;
  }

  analogReadResolution(12);
  uint32_t raw = analogRead(BATTERY_ADC_PIN);
  return static_cast<uint16_t>((raw * 3300UL) / 4095UL);
}

void enter_deep_sleep() {
  esp_sleep_enable_timer_wakeup(static_cast<uint64_t>(SAMPLE_INTERVAL_SEC) * 1000000ULL);
  esp_deep_sleep_start();
}

