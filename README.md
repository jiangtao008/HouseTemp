# 全屋温湿度监控项目

本项目当前包含两个基于 PlatformIO 的子工程：

- `sensor_node`：低功耗温湿度采集节点，硬件为 `ESP32-C3 + SHT40 + 电池`
- `ble_gateway`：BLE 到 WiFi/MQTT 网关，硬件为 `ESP32-S3 + ST7789 TFT`

当前目标链路如下：

```text
温湿度节点
   ↓ BLE 广播
ESP32-S3 网关
   ↓ WiFi / MQTT
Mosquitto Broker
   ↓
MQTT 客户端订阅
```

## 目录结构

```text
.
├── README.md
├── sensor_node
│   ├── platformio.ini
│   └── src
│       ├── ble_adv.cpp
│       ├── ble_adv.h
│       ├── config.h
│       ├── main.cpp
│       ├── power.cpp
│       ├── sht40.cpp
│       └── sht40.h
└── ble_gateway
    ├── platformio.ini
    └── src
        ├── ble_scan.cpp
        ├── ble_scan.h
        ├── config.cpp
        ├── config.h
        ├── display.cpp
        ├── display.h
        ├── main.cpp
        ├── mqtt.cpp
        ├── mqtt.h
        ├── node_registry.cpp
        ├── node_registry.h
        ├── serial_config.cpp
        ├── serial_config.h
        ├── status.h
        ├── wifi.cpp
        └── wifi.h
```

## 一、节点工程 `sensor_node`

### 1. 硬件角色

- 主控：`ESP32-C3`
- 传感器：`SHT40`
- 供电：锂电池 → TP4056 充电板(带保护) → 开发板 5V/VIN 持续供电，板上低压差 LDO 降压 3.3V

### 2. 当前功能

- 初始化 I2C 并读取 SHT40 温湿度
- 生成 BLE Manufacturer Data 广播包
- 广播持续约 3 秒
- 广播结束后进入 Deep Sleep
- 使用 `RTC_DATA_ATTR` 保存数据计数器，唤醒后继续递增

### 3. SHT40 接线

默认配置：

```text
ESP32-C3 GPIO8  -> SDA
ESP32-C3 GPIO9  -> SCL
3.3V            -> VCC
GND             -> GND
```

对应配置文件：
- `sensor_node/src/config.h`

### 4. 广播协议

当前广播载荷使用 `Manufacturer Data`，结构如下：

```cpp
struct SensorPacket {
  uint8_t protocol_ver;
  uint16_t device_id;
  uint32_t counter;
  int16_t temperature;
  uint8_t humidity;
  uint16_t battery_mv;
  uint32_t auth_tag;
};
```

字段说明：

- `protocol_ver`：协议版本号，当前为 `1`
- `device_id`：节点唯一编号
- `counter`：递增计数器，用于防重放
- `temperature`：温度，单位 `℃ x 100`
- `humidity`：湿度，单位 `%`
- `battery_mv`：电池电压，单位 `mV`
- `auth_tag`：认证标签，使用共享密钥计算

### 5. 安全机制

当前已经实现广播认证增强，目标是防伪造、防重放：

- 节点和网关共享同一组 `AUTH_KEY`
- 节点对广播包做 `HMAC-SHA256`
- 结果截断为 4 字节 `auth_tag`
- 网关收到广播后先验签
- 验签通过后再检查 `counter` 是否递增
- 若认证失败或 `counter` 回退，则网关丢弃该包

注意：

- 该方案主要解决“真实性”和“防重放”
- 广播内容本身仍然是可被附近设备接收到的，不属于保密传输

### 6. 电池电压检测

当前代码中保留了电池电压采样接口：

- `read_battery_mv()`
- `BATTERY_ADC_PIN`

当前默认：

- `BATTERY_ADC_PIN = -1`
- 即未启用真实 ADC 采样

实际供电拓扑（详见 [`sensor_node/README.md`](sensor_node/README.md) 的「供电与电池检测」）：

```text
锂电池 ── TP4056 充电板(带保护) ── OUT ── ESP32 开发板 5V ── 板上 3.3V LDO ── C3
```

采样要点：

- C3 ADC 满量程约 3.1V(11dB)，不能直接量 4.2V 电池，需 **100K:100K** 分压（÷2）到 ADC 引脚
- 取样点接 `OUT`（= B+）即可，量到的就是电池电压；充电时 TP4056 恒压段会读到 ~4.2V
- 常接分压器带来约 21µA 静态电流，建议增加 **MOSFET 控制分压支路**，仅在测量瞬间导通，降低静态功耗
- 放电截止受板上稳压器压差限制：低压差 LDO（ME6211 类）约 3.4V；AMS1117 类压差大，不适合此拓扑

### 7. 关键配置项

文件：`sensor_node/src/config.h`

需要根据实际硬件修改：

- `DEVICE_ID`
- `I2C_SDA_PIN`
- `I2C_SCL_PIN`
- `SAMPLE_INTERVAL_SEC`
- `ADVERTISE_DURATION_MS`
- `BATTERY_ADC_PIN`
- `AUTH_KEY`

## 二、网关工程 `ble_gateway`

### 1. 硬件角色

- 主控：`ESP32-S3`
- 无线能力：BLE 扫描 + WiFi
- 显示：`ST7789` SPI 屏幕，分辨率 `240 x 320`
- 按键：单独一个按钮，用于切换顶部 Tab 页面

### 2. 当前功能

- 扫描 BLE 广播
- 解析节点广播包
- 对广播包做认证校验
- 检查计数器，拦截重放包
- 上传 MQTT 数据
- 在 TFT 屏幕显示网关页和节点页

### 3. MQTT 上报

当前 Topic 格式：

```text
iot/device/{device_id}/sensor
```

示例：

```text
iot/device/10001/sensor
```

当前 Payload：

```json
{
  "id": 10001,
  "name": "Node-1",
  "temperature": 26.52,
  "humidity": 55,
  "battery": 3.02,
  "rssi": -45
}
```

`name` 由网关根据 `id` 在 `NODE_NAMES` 中查询后自动填入，与 TFT 屏幕显示使用同一份名称配置。未配置名称的节点上报 `"name":"Unnamed"`。

### 4. TFT 显示页面

当前已经实现顶部两个 Tab：

- `Gateway`
- `Nodes`

通过一个按钮单击切换页面，按钮逻辑为：

- 按钮引脚使用 `INPUT_PULLUP`
- 按下为低电平
- 每次单击在两个页面之间切换

#### Gateway 页面

当前显示：

- 网关名称 `gateway_config.gateway_name`
- WiFi 连接状态
- MQTT 连接状态
- 网关 IP 地址
- WiFi RSSI
- 已发现节点数量

#### Nodes 页面

当前使用列表方式显示多个节点，每行包括：

- 设备 ID
- 节点名
- 温度
- 湿度
- 电量

节点名由网关端 `ble_gateway/src/config.h` 中的 `NODE_NAMES` 配置表管理，并通过 `device_id` 匹配：

```cpp
constexpr NodeNameConfig NODE_NAMES[] = {
    {10001, "Node-1"},
    {10002, "Living"},
};
```

如果节点 ID 没有配置名称，屏幕显示 `Unnamed`。当前屏幕使用 Adafruit GFX 默认字体，节点名建议先使用不超过 8 个字符的英文或数字；若需显示“主卧”、“客厅”等中文名称，需要再接入中文字库。

屏幕列表示例：

```text
ID     NAME      TEMP   HUM   BAT
10001  Node-1    26.5C  55%   3.02V
```

### 5. 节点管理方式

当前网关不使用 BLE 配对，而是：

- 持续扫描广播
- 通过 `device_id` 区分不同节点
- 同一 `device_id` 的新数据会覆盖显示缓存

这意味着后续新增节点时，只需要：

- 为新节点分配新的 `device_id`
- 保持协议一致
- 保持 `AUTH_KEY` 一致

网关即可直接识别并接收

### 6. 当前限制

- 节点显示列表最多缓存 `MAX_DISPLAY_NODES` 个节点，当前默认 `8`
- 网关的防重放状态目前保存在 RAM 中
- 若网关重启，会丢失之前记录的 `counter`
- 当前节点名称使用网关端静态配置表，修改后需重新编译和烧录网关
- 网关名称、WiFi、MQTT 和认证密钥支持通过串口 JSON 协议读取和修改，配置保存到 ESP32 NVS
- 当前默认字体不支持中文节点名
- 当前显示内容已具备基础骨架，后续可以继续调整布局与字段

### 7. 关键配置项

文件：`ble_gateway/src/config.h`

需要根据实际硬件修改的主要是硬件和默认配置：

- `TFT_CS_PIN`
- `TFT_DC_PIN`
- `TFT_RST_PIN`
- `TFT_SCLK_PIN`
- `TFT_MOSI_PIN`
- `TFT_MISO_PIN`
- `TFT_BACKLIGHT_PIN`
- `TAB_BUTTON_PIN`
- `NODE_NAMES`

运行时配置通过串口协议修改，详细格式见 [`ble_gateway/SERIAL_CONFIG_PROTOCOL.md`](ble_gateway/SERIAL_CONFIG_PROTOCOL.md)：

- `gateway.name`
- `wifi.ssid`
- `wifi.password`
- `mqtt.host`
- `mqtt.port`
- `mqtt.username`
- `mqtt.password`
- `security.auth_key`

## 三、依赖库

### `sensor_node`

- `Adafruit SHT4x Library`
- `NimBLE-Arduino`

### `ble_gateway`

- `NimBLE-Arduino`
- `ArduinoJson`
- `PubSubClient`
- `Adafruit GFX Library`
- `Adafruit ST7735 and ST7789 Library`

## 四、开发方式

统一要求：

- 使用 `VSCode + PlatformIO`
- 不使用 Arduino IDE
- 不使用独立 ESP-IDF 命令行工程

## 五、建议的下一步

1. 按实际接线修改 `ble_gateway/src/config.h` 中的 TFT 和按钮引脚。
2. 通过串口协议设置网关 WiFi、MQTT、网关名称和 `security.auth_key`；网关和节点的认证密钥必须完全一致。
3. 在节点侧接入真实电池分压采样，替换当前占位实现。
4. 根据节点 `device_id` 在 `NODE_NAMES` 中配置节点名；若需中文名称，再接入中文字库。
5. 若需要更强的防重放能力，可将网关端最近 `counter` 持久化到 NVS。
