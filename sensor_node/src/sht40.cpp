#include "sht40.h"

#include <Adafruit_SHT4x.h>
#include <Wire.h>

#include "config.h"

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
