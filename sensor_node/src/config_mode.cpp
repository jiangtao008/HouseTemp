#include "config_mode.h"

#include <Arduino.h>

#include <cstdarg>
#include <cstdlib>
#include <cstring>

#include "config.h"
#include "node_config.h"

namespace {
constexpr size_t LINE_BUF_SIZE = 80;

// 同时写两条串口：USB-CDC Serial 与 UART0 Serial0。
void emit(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
void emit(const char *fmt, ...) {
  char buf[160];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof(buf), fmt, args);
  va_end(args);
  Serial.print(buf);
  Serial0.print(buf);
}

// 从两条串口逐字符收集一行输入（以 \n 结束，兼容 \r\n）。
// 返回 true 表示收齐一行；无数据时返回 false，行缓冲保留在静态区继续累积。
bool read_line(char *line, size_t max_len) {
  static char buf[LINE_BUF_SIZE];
  static size_t len = 0;

  while (Serial.available() > 0 || Serial0.available() > 0) {
    int c = (Serial.available() > 0) ? Serial.read() : Serial0.read();
    if (c < 0) {
      continue;
    }
    if (c == '\n') {
      buf[len] = '\0';
      if (len > 0 && buf[len - 1] == '\r') {
        buf[--len] = '\0';
      }
      // 回显输入行（UART0 等无本地回显的终端需要由 MCU 回显）。
      emit("%s\r\n", buf);
      strncpy(line, buf, max_len - 1);
      line[max_len - 1] = '\0';
      len = 0;
      return true;
    }
    if (c == '\r') {
      continue;  // 忽略 \r，等 \n 作为行尾
    }
    if (len < LINE_BUF_SIZE - 1) {
      buf[len++] = static_cast<char>(c);
    }
  }
  return false;
}

void print_help() {
  emit("Commands:\r\n");
  emit("  help              show this help\r\n");
  emit("  id <1..65535>     set node device id (persisted)\r\n");
  emit("  name <text>       set node name, up to %d chars (persisted)\r\n",
       NODE_NAME_MAX_LEN);
  emit("  show              show current config\r\n");
  emit("  reset             restore defaults\r\n");
  emit("  reboot            exit config mode and reboot\r\n");
  emit("> ");
}

void handle_line(const char *line) {
  while (*line == ' ' || *line == '\t') {
    ++line;
  }
  if (*line == '\0') {
    emit("> ");
    return;
  }

  if (strcmp(line, "help") == 0 || strcmp(line, "h") == 0) {
    print_help();
    return;
  }
  if (strcmp(line, "show") == 0) {
    node_config::print();
    emit("> ");
    return;
  }
  if (strcmp(line, "reset") == 0) {
    node_config::clear();
    emit("OK: config reset to defaults\r\n");
    node_config::print();
    emit("> ");
    return;
  }
  if (strcmp(line, "reboot") == 0 || strcmp(line, "exit") == 0) {
    emit("rebooting...\r\n");
    if (Serial) {
      Serial.flush();
    }
    Serial0.flush();
    delay(100);
    ESP.restart();
    return;  // 正常情况下执行不到
  }

  if (strncmp(line, "id ", 3) == 0) {
    char *end = nullptr;
    const long id = strtol(line + 3, &end, 10);
    // 必须是一个合法的正整数，且不允许带尾部垃圾字符。
    while (end != nullptr && (*end == ' ' || *end == '\t')) {
      ++end;
    }
    if (end == line + 3 || id <= 0 || id > 0xFFFF || (end != nullptr && *end != '\0')) {
      emit("ERROR: id must be an integer in 1..65535\r\n");
      emit("> ");
      return;
    }
    if (node_config::set_device_id(static_cast<uint16_t>(id))) {
      emit("OK: device_id=%u\r\n", node_config::device_id());
    } else {
      emit("ERROR: persist failed\r\n");
    }
    emit("> ");
    return;
  }

  if (strncmp(line, "name ", 5) == 0) {
    const char *val = line + 5;
    size_t len = strlen(val);
    while (len > 0 && (val[len - 1] == ' ' || val[len - 1] == '\t')) {
      --len;
    }
    if (len == 0 || len > NODE_NAME_MAX_LEN) {
      emit("ERROR: name must be 1..%d chars\r\n", NODE_NAME_MAX_LEN);
      emit("> ");
      return;
    }
    char buf[NODE_NAME_MAX_LEN + 1];
    memcpy(buf, val, len);
    buf[len] = '\0';
    if (node_config::set_name(buf)) {
      emit("OK: node_name=%s\r\n", node_config::name());
    } else {
      emit("ERROR: persist failed\r\n");
    }
    emit("> ");
    return;
  }

  emit("ERROR: unknown command: %s\r\n", line);
  print_help();
}
}  // namespace

void enter_config_mode() {
  emit("\r\n");
  emit("======================================\r\n");
  emit(" CONFIG MODE  (CONFIG_IO high)\r\n");
  emit(" Type 'help' for commands, 'reboot' to exit.\r\n");
  emit("======================================\r\n");
  node_config::print();
  emit("> ");

  char line[LINE_BUF_SIZE];
  while (true) {
    if (read_line(line, sizeof(line))) {
      handle_line(line);
    }
    // 配置模式是非低功耗模式：串口有数据立刻处理，无数据时忙等即可，无需省电。
  }
}
