#include <atomic>
#include <cstddef>
#include <cstring>

#include "ble_scan.h"

#include <mbedtls/md.h>

#include "config.h"

namespace {

struct DeviceReportState {
  uint16_t device_id;
  uint32_t last_seen_ms;  // 最近一次接受该设备报文的时间，表满时用于淘汰最久未见者
  bool used;
};

// 去重表只保留最近活跃的设备：表满时淘汰最久未见的条目，保证新节点永远有槽位、
// 不会被静默丢弃（不限制节点数）。数组大小只是内存上的上限，不构成设备数上限。
constexpr size_t kMaxTrackedDevices = 32;
DeviceReportState report_states[kMaxTrackedDevices] = {};

// 同一设备相邻两次被接受上报之间的最短间隔。节点每次广播约 3s，且同一广告会在
// 3 个 BLE 信道上被扫到（还可能在多个扫描窗口重复命中），没有该限流会被重复上报。
// 窗口取 10s：远小于节点 60s 的上报周期，足以把一次广播产生的重复折叠为一条；同时
// 不再依赖节点计数器——旧版"counter 严格递增"去重会在节点 RTC 计数器复位后永久
// 屏蔽该节点，正是"只上报一次"的诱因之一。
constexpr uint32_t kMinReportIntervalMs = 10000;

// ── SPSC queue: BLE callback → main loop ────────────────────────────────
// Single producer (NimBLE host task, onResult) and single consumer (loop
// task). Producer only writes packet_queue[tail] then advances tail; consumer
// only reads packet_queue[head] then advances head. head/tail are atomic with
// acquire/release ordering, which makes this safe without a lock.
constexpr size_t kPacketQueueCapacity = 32;

struct PacketQueueEntry {
  SensorPacket packet;
  int rssi;
};
PacketQueueEntry packet_queue[kPacketQueueCapacity];
std::atomic<uint32_t> queue_head{0};
std::atomic<uint32_t> queue_tail{0};

uint32_t calculate_auth_tag(const SensorPacket &packet) {
  unsigned char digest[32] = {0};
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr) {
    return 0;
  }

  const int rc = mbedtls_md_hmac(info, gateway_config.auth_key,
                                 sizeof(gateway_config.auth_key),
                                 reinterpret_cast<const unsigned char *>(&packet),
                                 offsetof(SensorPacket, auth_tag), digest);
  if (rc != 0) {
    return 0;
  }

  uint32_t tag = 0;
  memcpy(&tag, digest, sizeof(tag));
  return tag;
}

}  // namespace

bool parse_sensor_packet(const std::string &data, SensorPacket &packet) {
  if (data.size() != sizeof(SensorPacket)) {
    return false;
  }

  memcpy(&packet, data.data(), sizeof(SensorPacket));
  return true;
}

bool verify_sensor_packet(const SensorPacket &packet) {
  if (packet.protocol_ver != PROTOCOL_VERSION) {
    return false;
  }

  SensorPacket expected = packet;
  expected.auth_tag = 0;
  return calculate_auth_tag(expected) == packet.auth_tag;
}

bool accept_sensor_report(uint16_t device_id) {
  const uint32_t now_ms = millis();

  // 已见过的设备：距上次接受上报不足窗口则丢弃（折叠同一次广播在 3 个 BLE 信道
  // / 多个扫描窗口的重复），否则接受并刷新时间。不比较 counter，节点复位、RTC
  // 计数器归零都不会被屏蔽。
  for (auto &state : report_states) {
    if (!state.used) {
      continue;
    }
    if (state.device_id != device_id) {
      continue;
    }
    if (now_ms - state.last_seen_ms < kMinReportIntervalMs) {
      return false;
    }
    state.last_seen_ms = now_ms;
    return true;
  }

  // 新设备：优先填入空槽；表满则淘汰最久未见的条目，保证任何有效节点都不被丢弃。
  int evict = -1;
  uint32_t oldest = 0xFFFFFFFFu;
  for (size_t i = 0; i < kMaxTrackedDevices; ++i) {
    if (!report_states[i].used) {
      evict = static_cast<int>(i);
      break;
    }
    if (report_states[i].last_seen_ms < oldest) {
      oldest = report_states[i].last_seen_ms;
      evict = static_cast<int>(i);
    }
  }

  report_states[evict].used = true;
  report_states[evict].device_id = device_id;
  report_states[evict].last_seen_ms = now_ms;
  return true;
}

bool enqueue_sensor_packet(const SensorPacket &packet, int rssi) {
  const uint32_t tail = queue_tail.load(std::memory_order_relaxed);
  const uint32_t head = queue_head.load(std::memory_order_acquire);
  const uint32_t next = (tail + 1) % kPacketQueueCapacity;
  if (next == head) {
    return false;  // full — drop the packet
  }

  packet_queue[tail].packet = packet;
  packet_queue[tail].rssi = rssi;
  queue_tail.store(next, std::memory_order_release);
  return true;
}

bool dequeue_sensor_packet(QueuedSensorPacket &entry) {
  const uint32_t head = queue_head.load(std::memory_order_relaxed);
  const uint32_t tail = queue_tail.load(std::memory_order_acquire);
  if (head == tail) {
    return false;  // empty
  }

  entry.packet = packet_queue[head].packet;
  entry.rssi = packet_queue[head].rssi;
  queue_head.store((head + 1) % kPacketQueueCapacity, std::memory_order_release);
  return true;
}
