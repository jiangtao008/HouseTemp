#include <Arduino.h>
#include <Wire.h>
#include <esp_bt.h>
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

  // 诊断用。esp_deep_sleep_start() 不会正常返回：入睡成功则芯片立即复位；
  // 若睡眠被硬件拒绝，则会在其内部 while(1) 空转——从外部看就是“深睡后再也没醒来”。
  // bt_status: 0=IDLE 1=INITED 2=ENABLED。若入睡前仍是 ENABLED，说明 BLE 没关干净，
  // 深睡大概率进不去，整机就停在空 loop() / while(1) 里不再上报。
  Serial.printf("[sleep] entering deep sleep, bt_status=%d\n",
                static_cast<int>(esp_bt_controller_get_status()));
  Serial0.printf("[sleep] entering deep sleep, bt_status=%d\n",
                 static_cast<int>(esp_bt_controller_get_status()));
  // C3 的 USB-CDC 在无上位机读取时 flush() 可能阻塞，导致进不了深睡；仅在有上位机时刷新。
  if (Serial) {
    Serial.flush();
  }

  // 释放 I2C 总线：让 I2C 硬件以干净状态进入深睡。若不释放，深睡转换时总线/FSM 可能
  // 停在"忙"状态，唤醒后仅靠 Wire.begin() 不会自动恢复——这正是"冷启动温湿度正常、
  // 每次定时唤醒后变成哨兵值（-273℃/100%RH）"的典型原因。
  Wire.end();

  esp_deep_sleep_start();

  // 正常情况下执行不到这里。若打印了 FATAL，说明 esp_deep_sleep_start 返回了（睡眠被拒）。
  // 直接重启而不是空转：让节点继续上报，把“睡不进去”这个故障暴露出来。
  Serial.println("[sleep] FATAL: esp_deep_sleep_start returned, restarting");
  esp_restart();
}

