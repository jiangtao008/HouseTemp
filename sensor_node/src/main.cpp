#include <Arduino.h>
#include <esp_attr.h>

#include "ble_adv.h"
#include "config.h"
#include "sht40.h"

uint16_t read_battery_mv();
void enter_deep_sleep();

RTC_DATA_ATTR uint32_t packet_counter = 0;

void setup() {
  Serial.begin(115200);
  delay(200);

  if (!sht40_init()) {
    Serial.println("SHT40 init failed");
    enter_deep_sleep();
  }

  float temperature = 0.0f;
  float humidity = 0.0f;
  if (!sht40_read(temperature, humidity)) {
    Serial.println("SHT40 read failed");
    enter_deep_sleep();
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

  ble_adv_start(packet, ADVERTISE_DURATION_MS);
  delay(ADVERTISE_DURATION_MS);
  ble_adv_stop();
  enter_deep_sleep();
}

void loop() {}
