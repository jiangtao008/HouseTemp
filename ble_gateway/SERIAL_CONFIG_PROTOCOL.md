# 网关串口配置协议

## 1. 适用范围

本文定义网关通过串口进行参数读取、单个参数设置和设备重启的通信协议。

网关固件已实现本协议的命令解析，支持 `get`、`set`、`set_batch` 和 `reboot`。

## 2. 传输层

- 接口：网关 `Serial` 串口
- 波特率：`115200`
- 数据格式：`8N1`
- 编码：UTF-8
- 分帧方式：每条消息为一个 JSON 对象，以 `\n` 结尾
- 换行兼容：接收端应兼容 `\n` 和 `\r\n`
- 单条消息最大长度：建议 `512 bytes`
- 请求和响应均使用 `id` 关联

串口数据示例：

```text
{"v":1,"id":1,"cmd":"get","param":"gateway.name"}\n
```

## 3. 通用字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `v` | uint | 协议版本，当前为 `1` |
| `id` | uint | 请求编号，由上位机生成，响应原样返回 |
| `cmd` | string | 命令名称 |
| `param` | string | 参数名称；读取全部参数时使用 `*` |
| `value` | JSON value | 设置参数时使用，类型必须与参数定义一致 |
| `values` | object | 批量设置参数时使用，键为参数名，值为参数值 |

## 4. 命令

### 4.1 读取单个参数

请求：

```json
{"v":1,"id":1,"cmd":"get","param":"gateway.name"}
```

成功响应：

```json
{"v":1,"id":1,"ok":true,"param":"gateway.name","value":"gw-01"}
```

### 4.2 读取全部参数

请求：

```json
{"v":1,"id":2,"cmd":"get","param":"*"}
```

成功响应：

```json
{
  "v":1,
  "id":2,
  "ok":true,
  "values":{
    "gateway.name":"gw-01",
    "wifi.ssid":"HomeWiFi",
    "wifi.password":"******",
    "mqtt.host":"192.168.1.10",
    "mqtt.port":1883,
    "mqtt.username":"",
    "mqtt.password":"******"
  }
}
```

以下敏感参数默认必须脱敏：

- `wifi.password`
- `mqtt.password`
- `security.auth_key`

除非设备处于受控的物理配置模式，否则不应通过串口返回敏感参数明文。

### 4.3 设置单个参数

请求：

```json
{"v":1,"id":3,"cmd":"set","param":"mqtt.host","value":"192.168.1.20"}
```

成功响应：

```json
{
  "v":1,
  "id":3,
  "ok":true,
  "param":"mqtt.host",
  "changed":true,
  "persisted":true,
  "reboot_required":true
}
```

`set` 命令只修改并保存参数，不自动重启设备。网络相关参数在重启后生效。

如果新值与当前值相同，响应中的 `changed` 应为 `false`，但仍可返回 `persisted:true`。

### 4.4 批量设置参数

请求：

```json
{
  "v":1,
  "id":4,
  "cmd":"set_batch",
  "values":{
    "gateway.name":"gw-01",
    "wifi.ssid":"HomeWiFi",
    "wifi.password":"12345678",
    "mqtt.host":"192.168.1.20",
    "mqtt.port":1883
  }
}
```

成功响应：

```json
{
  "v":1,
  "id":4,
  "ok":true,
  "changed":5,
  "persisted":true,
  "reboot_required":true
}
```

批量设置必须采用原子语义：

1. 校验 `values` 中的所有参数名、类型和值域。
2. 只有全部参数校验通过后，才修改运行时配置并统一写入 NVS。
3. 任意一个参数校验失败时，所有参数都不得修改或保存。
4. 批量设置不会自动重启设备，由上位机随后发送 `reboot` 命令。

批量设置失败响应应指出具体失败参数：

```json
{
  "v":1,
  "id":4,
  "ok":false,
  "error":{
    "code":"INVALID_VALUE",
    "param":"mqtt.port",
    "message":"mqtt.port must be between 1 and 65535"
  }
}
```

### 4.5 控制重启

请求：

```json
{"v":1,"id":5,"cmd":"reboot"}
```

成功响应：

```json
{"v":1,"id":5,"ok":true,"action":"rebooting"}
```

设备发送响应并刷新串口缓冲区后，延迟约 `100 ms`，调用：

```cpp
ESP.restart();
```

## 5. 参数定义

| 参数名 | 类型 | 约束 | 重启后生效 |
| --- | --- | --- | --- |
| `gateway.name` | string | 长度 `1`～`32` | 是 |
| `wifi.ssid` | string | 长度 `1`～`32` | 是 |
| `wifi.password` | string | 长度 `0`～`64` | 是 |
| `mqtt.host` | string | IP 或域名，长度 `1`～`64` | 是 |
| `mqtt.port` | uint16 | `1`～`65535` | 是 |
| `mqtt.username` | string | 长度 `0`～`32` | 是 |
| `mqtt.password` | string | 长度 `0`～`64` | 是 |
| `security.auth_key` | hex string | 32 个十六进制字符，即 16 字节 | 是 |

节点名称可以扩展为动态参数：

```text
node.<device_id>.name
```

示例：

```json
{"v":1,"id":5,"cmd":"set","param":"node.10001.name","value":"Living"}
```

当前固件暂不支持 `node.<device_id>.name` 动态参数，节点名称仍由 `config.h` 中的静态表提供。

TFT 引脚、屏幕尺寸、按键引脚等硬件参数不开放串口修改，继续保留为编译期配置。

## 6. 错误响应

失败响应统一格式：

```json
{
  "v":1,
  "id":3,
  "ok":false,
  "error":{
    "code":"INVALID_VALUE",
    "message":"mqtt.port must be between 1 and 65535"
  }
}
```

建议错误码：

| 错误码 | 说明 |
| --- | --- |
| `BAD_JSON` | JSON 格式错误 |
| `UNSUPPORTED_VERSION` | 不支持的协议版本 |
| `MISSING_FIELD` | 缺少必要字段 |
| `UNKNOWN_COMMAND` | 未知命令 |
| `UNKNOWN_PARAMETER` | 未知参数 |
| `READ_ONLY` | 参数只读，不允许设置 |
| `INVALID_TYPE` | 参数类型错误 |
| `INVALID_VALUE` | 参数值超出范围或格式错误 |
| `PERSIST_FAILED` | NVS 保存失败 |
| `REBOOT_FAILED` | 重启操作失败 |

## 7. 配置保存约定

网关运行时配置使用 `GatewayConfig` 结构，并通过 ESP32 `Preferences/NVS` 保存。硬件引脚和默认值仍保留在 `ble_gateway/src/config.h`。

建议使用以下 NVS 命名空间：

```text
gateway_config
```

启动流程：

1. 从 NVS 读取配置。
2. 配置不存在或校验失败时使用默认值。
3. 使用运行时配置初始化 WiFi、MQTT 和显示模块。
4. `set` 或 `set_batch` 命令校验通过后写入 NVS；`set_batch` 必须统一写入。
5. 收到 `reboot` 命令后重启，使新配置生效。

建议增加物理配置模式。只有上电按住指定按键，或满足其他物理授权条件时，才允许读取敏感参数明文和修改配置。
