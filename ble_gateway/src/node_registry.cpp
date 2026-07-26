#include "node_registry.h"

#include "config.h"

const char *node_name_for_id(uint16_t device_id) {
  for (size_t index = 0; index < NODE_NAME_COUNT; ++index) {
    if (NODE_NAMES[index].device_id == device_id) {
      return NODE_NAMES[index].name;
    }
  }
  return "Unnamed";
}
