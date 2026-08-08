#include <Arduino.h>
#include <esp_attr.h>
#include <esp_sleep.h>

#include "ble_adv.h"
#include "config.h"
#include "sht40.h"

// ---- 调试开关 ----
//   DEEP_SLEEP_ENABLED = 1  深睡模式：每次上报后进入深睡，RTC 定时唤醒
//   DEEP_SLEEP_ENABLED = 0  调试模式：屏蔽深睡，常驻运行，每 SAMPLE_INTERVAL_SEC 秒上报一次
//   调试模式用于隔离“深睡/唤醒”环节，验证 BLE 广播本身是否稳定；测通后置 1 恢复深睡。
#define DEEP_SLEEP_ENABLED 1

uint16_t read_battery_mv();
void enter_deep_sleep();

RTC_DATA_ATTR uint32_t packet_counter = 0;

// 上电（冷启动）时打印完整的节点配置信息，便于串口诊断。
void print_node_info() {
  Serial.println("===== Sensor Node Info =====");
  Serial.printf("Device ID:       %u\n", DEVICE_ID);
  Serial.printf("Protocol Ver:    %u\n", PROTOCOL_VERSION);
  Serial.printf("Sample Interval: %lu s\n", (unsigned long)SAMPLE_INTERVAL_SEC);
  Serial.printf("Advertise:       %lu ms\n", (unsigned long)ADVERTISE_DURATION_MS);
  Serial.printf("I2C SDA:         %u\n", I2C_SDA_PIN);
  Serial.printf("I2C SCL:         %u\n", I2C_SCL_PIN);
  Serial.printf("Battery ADC:     %d\n", BATTERY_ADC_PIN);
  Serial.print("Auth Key:        ");
  for (uint8_t byte : AUTH_KEY) {
    Serial.printf("%02X", byte);
  }
  Serial.println();
  Serial.printf("Packet Counter:  %lu\n", (unsigned long)packet_counter);
  Serial.println("============================");
}

// 读传感器、组包并广播一次。深睡模式下由 setup() 调用一次后入睡；
// 调试模式下由 loop() 每 SAMPLE_INTERVAL_SEC 秒调用一次。
void send_once() {
  float temperature = 0.0f;
  float humidity = 0.0f;
  bool sensor_ok = sht40_init();
  if (sensor_ok) {
    sensor_ok = sht40_read(temperature, humidity);
  }
  if (!sensor_ok) {
    // 传感器读取失败也照常上报，用哨兵值标记（-273.00℃ / 100%RH），
    // 保证节点持续向网关发送、counter 持续递增，便于区分“节点已死”和“传感器坏了”。
    Serial.println("SHT40 read failed, sending sentinel packet");
    temperature = -273.0f;
    humidity = 100.0f;
  }

  SensorPacket packet{};
  packet.protocol_ver = PROTOCOL_VERSION;
  packet.device_id = DEVICE_ID;
  packet.counter = ++packet_counter;
  packet.temperature = static_cast<int16_t>(temperature * 100.0f);
  packet.humidity = static_cast<uint8_t>(constrain(lroundf(humidity), 0L, 100L));
  packet.battery_mv = read_battery_mv();
  packet.auth_tag = calculate_auth_tag(packet);

  Serial.printf("ID=%u C=%lu T=%.2f H=%.1f B=%umV TAG=%08lX\n",
                packet.device_id,
                static_cast<unsigned long>(packet.counter),
                temperature,
                humidity,
                packet.battery_mv,
                static_cast<unsigned long>(packet.auth_tag));
  Serial0.printf("ID=%u C=%lu T=%.2f H=%.1f B=%umV TAG=%08lX\n",
                 packet.device_id,
                 static_cast<unsigned long>(packet.counter),
                 temperature,
                 humidity,
                 packet.battery_mv,
                 static_cast<unsigned long>(packet.auth_tag));

  if (!ble_adv_start(packet, ADVERTISE_DURATION_MS)) {
    Serial.println("[boot] BLE advertise FAILED to start");
  } else {
    Serial.println("[boot] BLE advertise started OK");
  }
}

void setup() {
  Serial.begin(115200);
  Serial0.begin(115200);  // UART0：GPIO21(TX)/GPIO20(RX)，外接 USB-TTL 看串口用（3.3V）

  const esp_sleep_wakeup_cause_t wake_cause = esp_sleep_get_wakeup_cause();
  const bool cold_boot = (wake_cause != ESP_SLEEP_WAKEUP_TIMER);

  // 仅冷启动（非深睡定时唤醒）等待 5s，给串口监视器留出连接窗口，再打印节点信息。
  if (cold_boot) {
    delay(5000);
    print_node_info();
  } else {
    delay(200);
  }

  // 每次启动都打印唤醒原因与 RTC 计数器，用于区分故障：
  //  wake_cause=0 冷启动 / 4 定时唤醒；packet_counter 若每次都是 1 说明 RTC 内存被清零。
  Serial.printf("[boot] wake_cause=%d (%s) packet_counter=%lu\n",
                static_cast<int>(wake_cause),
                cold_boot ? "cold" : "timer",
                static_cast<unsigned long>(packet_counter));
  Serial0.printf("[boot] wake_cause=%d (%s) packet_counter=%lu\n",
                 static_cast<int>(wake_cause),
                 cold_boot ? "cold" : "timer",
                 static_cast<unsigned long>(packet_counter));

  send_once();

#if DEEP_SLEEP_ENABLED
  delay(ADVERTISE_DURATION_MS);  // 广播窗口
  ble_adv_stop();
  enter_deep_sleep();
#endif
}

void loop() {
#if !DEEP_SLEEP_ENABLED
  // 调试模式：常驻运行，每隔 SAMPLE_INTERVAL_SEC 秒上报一次，不进入深睡。
  delay(SAMPLE_INTERVAL_SEC * 1000UL);
  send_once();
#endif
}
