#include "sht40.h"

#include <Adafruit_SHT4x.h>
#include <Wire.h>

#include "config.h"

#if defined(SIMULATE_SENSOR)
#  include <esp_random.h>

namespace {
bool initialized = false;
}  // namespace

bool sht40_init() {
  initialized = true;
  Serial.println("SHT40: SIMULATE mode enabled");
  return true;
}

bool sht40_read(float &temperature, float &humidity) {
  if (!initialized) {
    return false;
  }

  // Simulate realistic room temperature (22.0 ~ 28.0 °C) with small drift.
  static float prev_temp = 25.0f;
  float drift = (static_cast<float>(esp_random() % 201) - 100.0f) / 100.0f;  // ±1.0 °C
  prev_temp += drift;
  if (prev_temp < 22.0f) prev_temp = 22.0f;
  if (prev_temp > 28.0f) prev_temp = 28.0f;
  temperature = prev_temp;

  // Simulate realistic humidity (40 ~ 70 %) inversely correlated to temp.
  float base_humi = 55.0f - (temperature - 25.0f) * 2.0f;
  float humi_drift = (static_cast<float>(esp_random() % 101) - 50.0f) / 100.0f * 3.0f;  // ±1.5 %
  humidity = base_humi + humi_drift;
  if (humidity < 40.0f) humidity = 40.0f;
  if (humidity > 70.0f) humidity = 70.0f;

  return true;
}

#else  // !SIMULATE_SENSOR

namespace {
Adafruit_SHT4x sensor;
bool initialized = false;
}  // namespace

bool sht40_init() {
  if (initialized) {
    return true;
  }

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  initialized = sensor.begin(&Wire);
  if (!initialized) {
    return false;
  }

  sensor.setPrecision(SHT4X_HIGH_PRECISION);
  sensor.setHeater(SHT4X_NO_HEATER);
  return true;
}

bool sht40_read(float &temperature, float &humidity) {
  if (!initialized && !sht40_init()) {
    return false;
  }

  sensors_event_t humidity_event, temp_event;
  if (!sensor.getEvent(&humidity_event, &temp_event)) {
    return false;
  }

  temperature = temp_event.temperature;
  humidity = humidity_event.relative_humidity;
  return true;
}

#endif  // SIMULATE_SENSOR

