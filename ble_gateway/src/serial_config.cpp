#include "serial_config.h"

#include <Arduino.h>
#include <ArduinoJson.h>

#include <cstring>

#include "config.h"

namespace {

constexpr size_t kLineMaxLength = 512;
constexpr size_t kDocumentCapacity = 1536;
// If a line is received without its trailing '\n' (e.g. the host forgot the
// newline), finalize it after this silent gap so a response is always produced
// instead of buffering forever.
constexpr uint32_t kLineIdleTimeoutMs = 200;

char line_buffer[kLineMaxLength + 1] = {};
size_t line_length = 0;
bool line_overflow = false;
uint32_t last_rx_ms = 0;

void send_response(JsonDocument &document) {
  serializeJson(document, Serial);
  Serial.write('\n');
}

void send_error(uint32_t id, bool has_id, const char *code, const char *message,
                const char *param = nullptr) {
  StaticJsonDocument<512> document;
  document["v"] = PROTOCOL_VERSION;
  if (has_id) {
    document["id"] = id;
  }
  document["ok"] = false;
  JsonObject error = document["error"].to<JsonObject>();
  error["code"] = code;
  if (param != nullptr) {
    error["param"] = param;
  }
  error["message"] = message;
  send_response(document);
}

bool copy_string_value(JsonVariantConst value, char *destination, size_t capacity,
                       size_t min_length, size_t max_length, const char *&error_code) {
  if (!value.is<const char *>()) {
    error_code = "INVALID_TYPE";
    return false;
  }

  const char *source = value.as<const char *>();
  if (source == nullptr) {
    error_code = "INVALID_TYPE";
    return false;
  }

  const size_t length = strlen(source);
  if (length < min_length || length > max_length || length >= capacity) {
    error_code = "INVALID_VALUE";
    return false;
  }

  memcpy(destination, source, length + 1);
  return true;
}

bool copy_hex_key(JsonVariantConst value, uint8_t *destination, size_t byte_count,
                  const char *&error_code) {
  if (!value.is<const char *>()) {
    error_code = "INVALID_TYPE";
    return false;
  }

  const char *source = value.as<const char *>();
  if (source == nullptr || strlen(source) != byte_count * 2) {
    error_code = "INVALID_VALUE";
    return false;
  }

  for (size_t index = 0; index < byte_count; ++index) {
    auto hex_value = [](char character) -> int {
      if (character >= '0' && character <= '9') {
        return character - '0';
      }
      if (character >= 'a' && character <= 'f') {
        return character - 'a' + 10;
      }
      if (character >= 'A' && character <= 'F') {
        return character - 'A' + 10;
      }
      return -1;
    };

    const int high = hex_value(source[index * 2]);
    const int low = hex_value(source[index * 2 + 1]);
    if (high < 0 || low < 0) {
      error_code = "INVALID_VALUE";
      return false;
    }
    destination[index] = static_cast<uint8_t>((high << 4) | low);
  }

  return true;
}

bool copy_port_value(JsonVariantConst value, uint16_t &destination,
                     const char *&error_code) {
  if (!value.is<long>() && !value.is<unsigned long>()) {
    error_code = "INVALID_TYPE";
    return false;
  }

  const long port = value.as<long>();
  if (port < 1 || port > 65535) {
    error_code = "INVALID_VALUE";
    return false;
  }

  destination = static_cast<uint16_t>(port);
  return true;
}

bool copy_u32_value(JsonVariantConst value, uint32_t &destination, const char *&error_code) {
  if (!value.is<long>() && !value.is<unsigned long>()) {
    error_code = "INVALID_TYPE";
    return false;
  }

  const unsigned long number = value.as<unsigned long>();
  if (number > 99999999) {
    error_code = "INVALID_VALUE";
    return false;
  }

  destination = static_cast<uint32_t>(number);
  return true;
}

bool apply_parameter(const char *param, JsonVariantConst value, GatewayConfig &config,
                     const char *&error_code) {
  if (strcmp(param, "gateway.id") == 0) {
    return copy_u32_value(value, config.gateway_id, error_code);
  }
  if (strcmp(param, "gateway.name") == 0) {
    return copy_string_value(value, config.gateway_name, sizeof(config.gateway_name), 1,
                             GATEWAY_NAME_MAX_LEN, error_code);
  }
  if (strcmp(param, "wifi.ssid") == 0) {
    return copy_string_value(value, config.wifi_ssid, sizeof(config.wifi_ssid), 1,
                             WIFI_SSID_MAX_LEN, error_code);
  }
  if (strcmp(param, "wifi.password") == 0) {
    return copy_string_value(value, config.wifi_password, sizeof(config.wifi_password), 0,
                             WIFI_PASSWORD_MAX_LEN, error_code);
  }
  if (strcmp(param, "mqtt.host") == 0) {
    return copy_string_value(value, config.mqtt_host, sizeof(config.mqtt_host), 1,
                             MQTT_HOST_MAX_LEN, error_code);
  }
  if (strcmp(param, "mqtt.port") == 0) {
    return copy_port_value(value, config.mqtt_port, error_code);
  }
  if (strcmp(param, "mqtt.username") == 0) {
    return copy_string_value(value, config.mqtt_username, sizeof(config.mqtt_username), 0,
                             MQTT_USERNAME_MAX_LEN, error_code);
  }
  if (strcmp(param, "mqtt.password") == 0) {
    return copy_string_value(value, config.mqtt_password, sizeof(config.mqtt_password), 0,
                             MQTT_PASSWORD_MAX_LEN, error_code);
  }
  if (strcmp(param, "security.auth_key") == 0) {
    return copy_hex_key(value, config.auth_key, sizeof(config.auth_key), error_code);
  }

  error_code = "UNKNOWN_PARAMETER";
  return false;
}

bool parameter_changed(const char *param, const GatewayConfig &before,
                       const GatewayConfig &after) {
  if (strcmp(param, "gateway.id") == 0) {
    return before.gateway_id != after.gateway_id;
  }
  if (strcmp(param, "gateway.name") == 0) {
    return strcmp(before.gateway_name, after.gateway_name) != 0;
  }
  if (strcmp(param, "wifi.ssid") == 0) {
    return strcmp(before.wifi_ssid, after.wifi_ssid) != 0;
  }
  if (strcmp(param, "wifi.password") == 0) {
    return strcmp(before.wifi_password, after.wifi_password) != 0;
  }
  if (strcmp(param, "mqtt.host") == 0) {
    return strcmp(before.mqtt_host, after.mqtt_host) != 0;
  }
  if (strcmp(param, "mqtt.port") == 0) {
    return before.mqtt_port != after.mqtt_port;
  }
  if (strcmp(param, "mqtt.username") == 0) {
    return strcmp(before.mqtt_username, after.mqtt_username) != 0;
  }
  if (strcmp(param, "mqtt.password") == 0) {
    return strcmp(before.mqtt_password, after.mqtt_password) != 0;
  }
  if (strcmp(param, "security.auth_key") == 0) {
    return memcmp(before.auth_key, after.auth_key, sizeof(before.auth_key)) != 0;
  }
  return false;
}

// ArduinoJson 7 note: object[key] returns a MemberProxy. Converting it to a
// JsonVariant and calling set() on the copy silently writes nothing when the
// key does not exist yet (the read-path JsonVariant is unbound). Always write
// through target[param] instead, so the member is created and assigned.
bool write_parameter(JsonObject target, const char *param, const GatewayConfig &config) {
  if (strcmp(param, "gateway.id") == 0) {
    target[param] = config.gateway_id;
  } else if (strcmp(param, "gateway.name") == 0) {
    target[param] = config.gateway_name;
  } else if (strcmp(param, "wifi.ssid") == 0) {
    target[param] = config.wifi_ssid;
  } else if (strcmp(param, "wifi.password") == 0) {
    target[param] = "******";
  } else if (strcmp(param, "mqtt.host") == 0) {
    target[param] = config.mqtt_host;
  } else if (strcmp(param, "mqtt.port") == 0) {
    target[param] = config.mqtt_port;
  } else if (strcmp(param, "mqtt.username") == 0) {
    target[param] = config.mqtt_username;
  } else if (strcmp(param, "mqtt.password") == 0) {
    target[param] = "******";
  } else if (strcmp(param, "security.auth_key") == 0) {
    target[param] = "******";
  } else {
    return false;
  }
  return true;
}

void add_all_parameters(JsonObject values, const GatewayConfig &config) {
  write_parameter(values, "gateway.id", config);
  write_parameter(values, "gateway.name", config);
  write_parameter(values, "wifi.ssid", config);
  write_parameter(values, "wifi.password", config);
  write_parameter(values, "mqtt.host", config);
  write_parameter(values, "mqtt.port", config);
  write_parameter(values, "mqtt.username", config);
  write_parameter(values, "mqtt.password", config);
  write_parameter(values, "security.auth_key", config);
}

void process_request(const char *line) {
  StaticJsonDocument<kDocumentCapacity> request;
  const DeserializationError parse_error = deserializeJson(request, line);
  if (parse_error) {
    send_error(0, false, "BAD_JSON", "request is not valid JSON");
    return;
  }

  JsonVariantConst id_value = request["id"];
  const bool has_id = !id_value.isNull();
  const uint32_t id = id_value.as<uint32_t>();
  if (!has_id) {
    send_error(0, false, "MISSING_FIELD", "id is required");
    return;
  }
  if (request["v"].isNull()) {
    send_error(id, true, "MISSING_FIELD", "v is required");
    return;
  }
  if (!request["v"].is<int>() || request["v"].as<int>() != PROTOCOL_VERSION) {
    send_error(id, has_id, "UNSUPPORTED_VERSION", "unsupported protocol version");
    return;
  }

  const char *command = request["cmd"] | "";
  if (command[0] == '\0') {
    send_error(id, has_id, "MISSING_FIELD", "cmd is required");
    return;
  }

  if (strcmp(command, "get") == 0) {
    const char *param = request["param"] | "";
    if (param[0] == '\0') {
      send_error(id, has_id, "MISSING_FIELD", "param is required");
      return;
    }

    StaticJsonDocument<kDocumentCapacity> response;
    response["v"] = PROTOCOL_VERSION;
    response["id"] = id;
    response["cmd"] = "get";
    response["ok"] = true;
    if (strcmp(param, "*") == 0) {
      JsonObject values = response["values"].to<JsonObject>();
      add_all_parameters(values, gateway_config);
    } else {
      response["param"] = param;
      // Write into a scratch object first (see write_parameter note), then copy
      // the value out under the protocol's top-level "value" key.
      StaticJsonDocument<256> value_doc;
      JsonObject value_obj = value_doc.to<JsonObject>();
      if (!write_parameter(value_obj, param, gateway_config)) {
        send_error(id, true, "UNKNOWN_PARAMETER", "unknown parameter", param);
        return;
      }
      response["value"] = value_obj[param];
    }
    send_response(response);
    return;
  }

  if (strcmp(command, "set") == 0) {
    const char *param = request["param"] | "";
    if (param[0] == '\0' || request["value"].isNull()) {
      send_error(id, has_id, "MISSING_FIELD", "param and value are required");
      return;
    }

    GatewayConfig candidate = gateway_config;
    const char *error_code = nullptr;
    if (!apply_parameter(param, request["value"], candidate, error_code)) {
      send_error(id, has_id, error_code, "parameter validation failed", param);
      return;
    }
    if (!config_save(candidate)) {
      send_error(id, has_id, "PERSIST_FAILED", "failed to save configuration");
      return;
    }

    const bool changed = parameter_changed(param, gateway_config, candidate);
    gateway_config = candidate;
    StaticJsonDocument<512> response;
    response["v"] = PROTOCOL_VERSION;
    response["id"] = id;
    response["cmd"] = "set";
    response["ok"] = true;
    response["param"] = param;
    response["changed"] = changed;
    response["persisted"] = true;
    response["reboot_required"] = true;
    send_response(response);
    return;
  }

  if (strcmp(command, "set_batch") == 0) {
    JsonObjectConst values = request["values"].as<JsonObjectConst>();
    if (values.isNull() || values.size() == 0) {
      send_error(id, has_id, "MISSING_FIELD", "values must be a non-empty object");
      return;
    }

    GatewayConfig candidate = gateway_config;
    for (JsonPairConst pair : values) {
      const char *param = pair.key().c_str();
      const char *error_code = nullptr;
      if (!apply_parameter(param, pair.value(), candidate, error_code)) {
        send_error(id, has_id, error_code, "parameter validation failed", param);
        return;
      }
    }

    if (!config_save(candidate)) {
      send_error(id, has_id, "PERSIST_FAILED", "failed to save configuration");
      return;
    }

    uint16_t changed = 0;
    for (JsonPairConst pair : values) {
      if (parameter_changed(pair.key().c_str(), gateway_config, candidate)) {
        ++changed;
      }
    }
    gateway_config = candidate;

    StaticJsonDocument<512> response;
    response["v"] = PROTOCOL_VERSION;
    response["id"] = id;
    response["cmd"] = "set_batch";
    response["ok"] = true;
    response["changed"] = changed;
    response["persisted"] = true;
    response["reboot_required"] = true;
    send_response(response);
    return;
  }

  if (strcmp(command, "reboot") == 0) {
    StaticJsonDocument<256> response;
    response["v"] = PROTOCOL_VERSION;
    response["id"] = id;
    response["cmd"] = "reboot";
    response["ok"] = true;
    response["action"] = "rebooting";
    send_response(response);
    Serial.flush();
    delay(100);
    ESP.restart();
    return;
  }

  send_error(id, has_id, "UNKNOWN_COMMAND", "unknown command");
}

// Finalize the buffered line and always send a response, whatever the state:
// overflow → "exceeds maximum length"; non-empty → process (its parse errors
// already produce their own error reply); empty → explicit "empty request".
void finalize_line() {
  if (line_overflow) {
    send_error(0, false, "BAD_JSON", "request exceeds maximum length");
  } else if (line_length > 0) {
    line_buffer[line_length] = '\0';
    process_request(line_buffer);
  } else {
    send_error(0, false, "BAD_JSON", "empty request");
  }
  line_length = 0;
  line_overflow = false;
}

}  // namespace

// Called once after boot (and after every reboot). Gives the host a positive
// signal that the gateway is back online, since the command/response exchange
// is otherwise interrupted by the restart.
void serial_config_notify_boot() {
  StaticJsonDocument<128> document;
  document["v"] = PROTOCOL_VERSION;
  document["event"] = "boot";
  document["ok"] = true;
  document["gateway"] = gateway_config.gateway_name;
  document["gateway_id"] = gateway_config.gateway_id;
  send_response(document);
  Serial.flush();
}

void serial_config_update() {
  while (Serial.available() > 0) {
    const char character = static_cast<char>(Serial.read());
    last_rx_ms = millis();
    if (character == '\n') {
      finalize_line();
      continue;
    }
    if (character == '\r') {
      continue;
    }
    if (line_overflow) {
      continue;
    }
    if (line_length >= kLineMaxLength) {
      line_overflow = true;
      continue;
    }
    line_buffer[line_length++] = character;
  }

  // The line was never terminated with '\n' and the bus has been quiet long
  // enough — treat the buffered data as one complete (likely malformed) line
  // so the client always gets a reply instead of hanging.
  if (line_length > 0 && (millis() - last_rx_ms) >= kLineIdleTimeoutMs) {
    finalize_line();
  }
}
