# Sensor Node — ESP32-C3 温湿度传感器节点

基于 ESP32-C3 (Mini) 的 BLE 温湿度广播节点，使用 SHT40 传感器采集数据，通过 NimBLE 广播传感器数据包。

## 硬件

| 组件 | 说明 |
|------|------|
| MCU | ESP32-C3 (Mini 开发板) |
| 传感器 | SHT40 (I2C, 地址 0x44) |
| I2C | SDA=GPIO8, SCL=GPIO9 |
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

## 模拟模式

如果没有连接 SHT40 传感器，可通过编译标志启用模拟数据：

```ini
# platformio.ini
build_flags =
  -std=gnu++17
  -DSIMULATE_SENSOR    # 取消此行注释以启用模拟模式
```

模拟数据范围：
- 温度：22.0 ~ 28.0 °C（带随机漂移）
- 湿度：40 ~ 70 %（与温度呈轻微负相关）

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
| I2C SDA | GPIO8 |
| I2C SCL | GPIO9 |
| 电池 ADC | 未启用 (BATTERY_ADC_PIN = -1) |

所有配置项见 [`src/config.h`](src/config.h)。
