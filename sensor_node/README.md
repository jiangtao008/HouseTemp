# Sensor Node — ESP32-C3 温湿度传感器节点

基于 ESP32-C3 (Mini) 的 BLE 温湿度广播节点，使用 SHT40 传感器采集数据，通过 NimBLE 广播传感器数据包。

## 硬件

| 组件 | 说明 |
|------|------|
| MCU | ESP32-C3 (Mini 开发板) |
| 传感器 | SHT40 (I2C, 地址 0x44) |
| I2C | SDA=GPIO4, SCL=GPIO5 |
| 配置模式开关 | GPIO3（内部下拉，悬空=正常模式；短接 3.3V=配置模式） |
| 供电 | USB 或电池 (ADC 引脚 BATTERY_ADC_PIN) |

## 烧录指南

### 进入下载模式

ESP32-C3 上电/复位时会检测 **GPIO9 (BOOT 按钮)** 的电平状态：

| GPIO9 电平 | 模式 |
|------------|------|
| 低电平 (按住 BOOT) | **下载模式** |
| 高电平 (不按 BOOT) | 正常启动 |

**手动进入下载模式的按键顺序：**

```
1. 按住 BOOT 按钮（不要松手）
2. 按一下 RESET 按钮（然后松开）
3. 松开 BOOT 按钮
```

> 成功进入下载模式后，PlatformIO 的 esptool.py 即可识别并烧录。

**烧录完成后：** 按一下 **RESET** 按钮，程序正常启动运行。

> PlatformIO 上传时会通过 DTR/RTS 信号尝试自动复位进入下载模式，有时候可以直接成功；如果自动方式失败，用手动按键方式成功率 100%。

### PlatformIO 命令

```bash
# 编译
platformio run

# 烧录
platformio run --target upload

# 串口监视器 (115200 baud)
platformio device monitor -b 115200
```

## BLE 广播协议

传感器节点以 **不可连接广播 (Non-connectable advertising)** 方式发送数据包，结构如下：

```cpp
struct __attribute__((packed)) SensorPacket {
  uint8_t  protocol_ver;   // 协议版本号
  uint16_t device_id;      // 设备 ID
  uint32_t counter;        // 数据包计数器
  int16_t  temperature;    // 温度，单位 0.01°C (×100)
  uint8_t  humidity;       // 湿度，单位 %
  uint16_t battery_mv;     // 电池电压 (mV)
  uint32_t auth_tag;       // HMAC-SHA256 认证标签 (取前 4 字节)
};
```

### 串口日志格式

```
ID=<device_id> C=<counter> T=<temp_°C> H=<humi_%> B=<battery_mV> TAG=<auth_tag_hex>
```

## 认证

数据包使用 **HMAC-SHA256** 进行完整性认证，密钥在 `config.h` 中配置。网关收到数据包后应使用相同的密钥重新计算认证标签进行校验。

## 引脚配置

| 功能 | 引脚 |
|------|------|
| I2C SDA | GPIO4 |
| I2C SCL | GPIO5 |
| 配置模式检测 IO | GPIO3（内部下拉，`CONFIG_IO_PIN`） |
| 电池 ADC | 未启用 (BATTERY_ADC_PIN = -1) |

所有配置项见 [`src/config.h`](src/config.h)。

## 配置模式（非低功耗）

节点增加了一个硬件 IO 开关，用于在不重新烧录的情况下修改节点 ID 和节点名。

| 上电时 CONFIG_IO_PIN 电平 | 行为 |
|------|------|
| **低电平**（默认，开关断开） | 正常低功耗模式：60s 深睡 + BLE 广播 |
| **高电平**（GPIO3 短接 3.3V） | **配置模式**：不深睡，串口可设置节点 ID / 节点名 |

### 进入配置模式

1. 将 `CONFIG_IO_PIN`（默认 GPIO3）短接到 **3.3V**
2. 给节点上电 / 按 RESET
3. 串口出现配置模式提示符（USB-CDC `Serial` 与 UART0 `Serial0` 均可，115200 baud）

### 串口命令

| 命令 | 说明 |
|------|------|
| `help` / `h` | 显示命令列表 |
| `id <1..65535>` | 设置并持久化节点 ID |
| `name <文本>` | 设置并持久化节点名（最长 32 字符） |
| `show` | 显示当前配置 |
| `reset` | 清空已保存配置，恢复默认 |
| `reboot` / `exit` | 退出配置模式并重启（进入正常低功耗流程） |

配置写入后**立即持久化到 NVS**，重启后生效。

### 退出配置模式

- 串口发送 `reboot`（或 `exit`）；或
- 断开 GPIO3 的短接，然后按 RESET

> 注意：修改节点 ID 后，需同步更新网关的节点名表
> [`ble_gateway/src/config.h`](../ble_gateway/src/config.h)（`NODE_NAMES`）
> 以及服务端数据库中该节点的名称，网关面板才会显示正确的名称。
