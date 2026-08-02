# service —— 全屋温湿度监控服务端

订阅 MQTT 上的温湿度节点上报，落库存储，并提供一个 Web 页面用于显示与配置。

数据链路：`sensor_node`（BLE 广播）→ `ble_gateway`（WiFi/MQTT 上报）→ **本服务订阅存库** → Web 展示。

## 功能

- 订阅 `iot/device/+/sensor`，自动发现节点，将温湿度/电池/信号落库（SQLite）
- Web 两个 Tab：
  - **主页面**：默认页，以可自由拖动的**圆角矩形面板**展示所有已订阅节点的最新信息（设备名、温度、湿度、电池、信号）；支持自定义背景图片；支持「锁定全部」防止误拖
  - **订阅页面**：勾选需要订阅显示的节点、为节点改名、查看 MQTT 连接状态，并可在页面内修改 **MQTT 服务配置**（地址/端口/用户名/密码，保存后自动重连）
- 数据 10 秒轮询刷新（节点约 5 分钟一报，足够实时）
- 默认 MQTT 服务为本地 `127.0.0.1:1883`（与 Mosquitto 同机部署开箱即用）

## 技术栈

Node.js 18+ · Express · mqtt.js · better-sqlite3 · Vue 3（CDN，免构建）

## 目录结构

```
service/
├── package.json / package-lock.json  # 依赖与锁文件
├── config.example.json               # 配置模板（提交）
├── config.json                       # 实际配置（git 忽略，首次部署时复制）
├── server.js                         # 入口：Express 接线 + MQTT 启动 + 历史清理
├── config.js                         # 配置加载（JSON，深合并默认值）
├── db.js                             # SQLite 建表/CRUD/落库/清理（better-sqlite3）
├── mqtt.js                           # MQTT 订阅、解析校验、落库
├── routes/                           # nodes / telemetry / layout / settings / status
├── public/                           # Vue 单页（index.html + app.js + style.css）
│   └── uploads/                      # 用户上传的背景图片（git 忽略）
├── data/                             # SQLite 数据库（运行时创建，git 忽略）
└── deploy/thermo-service.service     # Debian systemd 单元示例
```

## 本地开发运行

```bash
cd service
npm install                      # 安装依赖（better-sqlite3 会自动下载/编译原生模块）
cp config.example.json config.json   # 按需修改 mqtt.host 等
npm start                        # 启动，默认 0.0.0.0:8000
```

打开 <http://127.0.0.1:8000/> 即可看到 Web 页面。

## 配置（config.json）

```json
{
  "mqtt": { "host": "127.0.0.1", "port": 1883, "username": "", "password": "", "topic": "iot/device/+/sensor" },
  "database": { "path": "data/thermo.db", "retention_days": 30 },
  "server": { "host": "0.0.0.0", "port": 8000 },
  "storage": { "upload_dir": "public/uploads", "max_upload_mb": 10 }
}
```

说明：
- **MQTT 连接参数以 Web 端设置为准**：首次启动时用 `config.json` 的 `mqtt.*` 作为初始值写入数据库（`settings` 表），之后在订阅页「MQTT 设置」中修改并保存即实时生效（自动重连），并跨重启保留；`config.json` 只在数据库无该值时生效
- `mqtt.topic` 仅由 `config.json` 控制（固定为 `iot/device/+/sensor`，不在 Web 端修改）
- `database.retention_days`：历史数据保留天数，`0` 表示不清理
- 所有相对路径相对 `service/` 目录解析

## Debian 部署

```bash
# 安装 Node.js 18+（Debian 12 自带 nodejs 18）
sudo apt update && sudo apt install -y nodejs npm

sudo mkdir -p /srv/thermo-service
sudo cp -r . /srv/thermo-service/               # 将 service/ 内容拷贝至此
cd /srv/thermo-service
sudo npm install --omit=dev
sudo cp config.example.json config.json && sudo vim config.json   # 填写 broker 地址等

sudo useradd -r -M -d /srv/thermo-service thermo
sudo chown -R thermo:thermo /srv/thermo-service

sudo cp deploy/thermo-service.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now thermo-service

journalctl -u thermo-service -f                  # 查看日志
```

浏览器访问 `http://<服务器IP>:8000/`。

### Mosquitto 说明

- 服务端**订阅** `iot/device/+/sensor`，网关**发布**同一通配符主题，broker 需同时放行两边的 ACL
- 发布 QoS 0、无 retain，服务端启动晚于网关上电也无需担心——节点每 5 分钟重新上报
- 默认连接本地 `127.0.0.1:1883`（与 Mosquitto 同机）；若网关发布到局域网内其他主机，在订阅页「MQTT 设置」中改地址即可
- 先手动验证链路：
  ```bash
  mosquitto_sub -h 127.0.0.1 -t 'iot/device/+/sensor' -v
  mosquitto_pub -h 127.0.0.1 -t iot/device/10001/sensor \
    -m '{"id":10001,"name":"Node-1","temperature":26.5,"humidity":55,"battery":3.02,"rssi":-45}'
  ```

## MQTT 协议（与网关一致，无需改固件）

- Topic：`iot/device/{device_id}/sensor`
- 负载 JSON：

```json
{"id":10001,"name":"Node-1","temperature":26.52,"humidity":55,"battery":3.02,"rssi":-45}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| id | int | 节点 ID（主键） |
| name | string | 网关内置名称，可能为 "Unnamed"（可在订阅页改名覆盖） |
| temperature | float | 摄氏度 |
| humidity | int | 相对湿度 % |
| battery | float | 电池电压 V（ADC 未启用时可能为 0） |
| rssi | int | BLE 信号强度 dBm |

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/nodes?subscribed=true` | 节点列表（订阅状态、最新数据、离线标记） |
| PUT | `/api/nodes/{id}` | 设置订阅 / 修改显示名 `{"subscribed":true,"display_name":"主卧"}` |
| GET | `/api/telemetry/{id}?limit=100` | 历史数据 |
| GET | `/api/layout` | 面板位置 |
| PUT | `/api/layout/{id}` | 保存面板位置 `{"x":..,"y":..,"w":..,"h":..}`（%） |
| GET | `/api/settings` | 背景图、锁定状态 |
| PUT | `/api/settings` | 更新锁定状态 / 背景 |
| POST | `/api/background` | multipart 上传背景图片 |
| GET | `/api/status` | MQTT 连接、运行时间、节点数 |
| GET | `/api/mqtt` | MQTT 当前配置（不回传密码）+ 连接状态 |
| PUT | `/api/mqtt` | 修改 MQTT 配置并重连 `{"host","port","username","password?"}`；`clear_password:true` 清除密码 |

## 常见问题

- **订阅页显示「MQTT 未连接」**：在订阅页「MQTT 设置」中确认 broker 地址/端口/认证，保存后自动重连；确认网关能发布（用 `mosquitto_pub` 手动发一条验证）。
- **节点不出现**：节点约 5 分钟一报，首次上报后才被自动发现；检查网关 `NODE_NAMES` 外的节点名显示为 "Unnamed"，可在订阅页改名。
- **面板位置刷新后丢失**：拖动结束时自动保存到数据库；确认浏览器能访问 `/api/layout`（本服务同源部署，一般无跨域问题）。
- **电池显示「—」**：该节点电池 ADC 未启用，上报 0V，属正常。
- **`npm install` 报 better-sqlite3 编译失败**：通常需要系统编译工具链（`sudo apt install build-essential python3`），或换用有预编译二进制的 Node 版本。
