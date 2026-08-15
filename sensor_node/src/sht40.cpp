#include "sht40.h"

#include <Adafruit_SHT4x.h>
#include <Wire.h>

#include "config.h"

namespace {
Adafruit_SHT4x sensor;
bool initialized = false;

// 深睡唤醒后 I2C 偶发卡死：总线可能被从机把 SDA 拉低（bus stuck），而 SCL 翻转是
// 标准的恢复办法——用 SCL 把总线"时钟出来"（最多 9 个时钟），SDA 释放后提前结束。
void i2c_bus_recover() {
  // 先把 I2C 驱动释放掉：否则下方 pinMode 把引脚切成 GPIO 模式后，Wire.begin()
  // 因总线已初始化是 no-op，引脚不会配回 I2C 功能，后续 I2C 事务全部失败。
  Wire.end();

  pinMode(I2C_SDA_PIN, INPUT_PULLUP);
  pinMode(I2C_SCL_PIN, OUTPUT);
  digitalWrite(I2C_SCL_PIN, HIGH);
  delay(5);

  for (int i = 0; i < 9; ++i) {
    digitalWrite(I2C_SCL_PIN, LOW);
    delayMicroseconds(10);
    digitalWrite(I2C_SCL_PIN, HIGH);
    delayMicroseconds(10);
    if (digitalRead(I2C_SDA_PIN) == HIGH) {
      break;  // SDA 已释放
    }
  }

  pinMode(I2C_SCL_PIN, INPUT_PULLUP);
  delay(5);

  // 再发一次 I2C 通用呼叫软复位（0x00 -> 0x06），让 SHT40 回到默认状态。
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  delay(5);
  Wire.beginTransmission(0x00);
  Wire.write(0x06);
  Wire.endTransmission();
  delay(10);
}

// 尝试一次完整初始化（Wire.begin + sensor.begin + 精度/加热器配置）。
bool sht40_begin_once() {
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  delay(10);  // 唤醒后给总线一点稳定时间
  if (!sensor.begin(&Wire)) {
    return false;
  }
  sensor.setPrecision(SHT4X_HIGH_PRECISION);
  sensor.setHeater(SHT4X_NO_HEATER);
  return true;
}
}  // namespace

bool sht40_init() {
  if (initialized) {
    return true;
  }

  initialized = sht40_begin_once();
  if (initialized) {
    return true;
  }

  // 冷启动正常，但深睡定时唤醒后第一次 begin 常失败（I2C 总线/FSM 停在坏状态）。
  // 主动恢复总线后再试一次，避免直接发哨兵值。
  Serial.println("[sht40] begin failed, recovering I2C bus and retrying");
  i2c_bus_recover();
  initialized = sht40_begin_once();
  if (!initialized) {
    Serial.println("[sht40] begin failed again after bus recovery");
  }
  return initialized;
}

bool sht40_read(float &temperature, float &humidity) {
  if (!initialized && !sht40_init()) {
    return false;
  }

  // 唤醒后第一次测量偶发 NACK/CRC 错误：失败时重试几次再上报哨兵值。
  for (int attempt = 0; attempt < 3; ++attempt) {
    sensors_event_t humidity_event, temp_event;
    if (sensor.getEvent(&humidity_event, &temp_event)) {
      temperature = temp_event.temperature;
      humidity = humidity_event.relative_humidity;
      return true;
    }
    delay(50);
  }
  return false;
}
