# service —— 全屋温湿度监控服务端

订阅 MQTT 上的温湿度节点上报，落库存储，并提供一个 Web 页面用于显示与配置。

数据链路：`sensor_node`（BLE 广播）→ `ble_gateway`（WiFi/MQTT 上报）→ **本服务订阅存库** → Web 展示。

## 功能

- **多用户登录**：登录页支持登录/注册（Tab 切换）；登录后主界面右上角显示用户名 + 头像（用户名首字），点击弹出「退出登录」菜单
- **数据完全隔离**：每个用户的面板、MQTT 连接、节点、历史曲线相互独立，登录后加载各自的配置
- **管理员（仅账号管理）**：初始管理员由 `config.json` 配置；管理员可查看用户列表、重置密码、删除用户，但看不到其他用户的配置数据
- 订阅配置的 MQTT 主题（支持 `+`/`#` 通配符），将温湿度/电池/信号落库（SQLite）
- Web 两个 Tab：
  - **主页面**：默认页，主舞台一次显示一个**面板容器**，容器内以流式卡片展示其绑定的**节点小面板**（设备名、温度、湿度、电池、信号）。右侧**面板管理表**（二级）管理：面板容器可增删、**改名**、**锁定/解锁**（锁定后禁止改名、删除、增删小面板，仍可查看），点击切换显示；展开某面板可见其节点小面板，并可用「添加节点」下拉把订阅主题加入（同一主题可加入多个面板，单个面板内不重复）。MQTT 消息到达时对应小面板自动刷新
  - **订阅页面**：每个 **MQTT 连接**以同级别卡片平铺展示，卡片内含服务器配置与**该连接上报的节点**（可勾选订阅、改名）；顶部「＋ 添加服务器」新增连接，每条连接独立启用/停用、独立订阅主题列表，保存后自动重连
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
├── mqtt.js                           # MQTT 连接管理器（多条连接、订阅、解析校验、落库）
├── routes/                           # nodes / telemetry / layout / settings / status
├── public/                           # Vue 单页（index.html + app.js + style.css）
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
  "mqtt": { "host": "127.0.0.1", "port": 1883, "username": "", "password": "", "topics": [] },
  "database": { "path": "data/thermo.db", "retention_days": 30 },
  "server": { "host": "0.0.0.0", "port": 8000 },
  "storage": { "upload_dir": "public/uploads", "max_upload_mb": 10 },
  "admin": { "username": "admin", "password": "" }
}
```

说明：
- **登录/多用户**：所有用户需登录后使用。每个用户的 MQTT 连接、节点、面板、历史数据完全隔离。新用户注册时按 `config.json` 的 `mqtt.*` 初始化一条「默认连接」（开箱即用，可在订阅页增删改）
- **初始管理员**：`admin.username/password` 非空时，服务启动自动创建该管理员账号（已存在则保证其为管理员，不覆盖密码）；两者留空则不创建管理员。**注意**：升级到多用户版本后，旧库的节点/面板/MQTT/历史数据会被清空（从零开始），请先备份 `data/thermo.db`
- **MQTT 连接以 Web 端管理为准**：连接（含地址/端口/用户名/密码/启用开关/订阅主题）存 `mqtt_connections` 表，可在订阅页平铺的连接卡片中增删改，保存后自动重连该连接并跨重启保留；`config.json` 的 `mqtt.*` 仅用于**新用户注册时**初始化第一条「默认连接」
- `mqtt.topics`：订阅主题列表（如 `["gateway_1/node_5/temperature", "gateway_+/node_+/#"]`，支持 `+`/`#` 通配符）；**为空时不订阅任何主题**。每条连接有独立的主题列表，通过对应连接卡片里的输入框逐个添加
- **节点归属连接**：`nodes` 表的 `connection_id` 记录每个节点最近一次由哪条连接上报，订阅页节点按连接分组显示在各卡片下；删除连接后其节点归入「未关联连接的节点」分组（`connection_id` 置空），仍可订阅/改名，节点再次上报会重新归属
- **旧版单配置自动迁移**：升级启动时若 `settings` 表里存在旧的 `mqtt_host/mqtt_port/mqtt_username/mqtt_password/mqtt_topics` 扁平键，会自动迁移为一条名为「默认连接」的连接并删除这些键；已迁过或用户删光全部连接后不再重建（`mqtt_seeded` 标记保证幂等）
- **旧数据库自动迁移**：升级启动时若检测到旧 schema（nodes 只有 `device_id` 主键），自动迁移为 `(gateway_id, device_id)` 复合身份，旧数据归入 `gateway_id=0`；旧库还会自动补 `connection_id` 列，历史节点归入未关联分组
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

- 服务端**订阅**「订阅主题」里配置的 Topic（默认空，不订阅任何主题），网关**发布** `gateway_<网关id>/node_<节点id>/temperature`；broker 需同时放行两边的 ACL。填 `+/+/temperature` 或 `#` 即可订阅全部场景全部节点（注意：MQTT 规范里 `+` 必须独占整个层级，`gateway_+/node_+/#` 这类写法不合法，会被校验拒绝）
- 发布 QoS 0、无 retain，服务端启动晚于网关上电也无需担心——节点每 5 分钟重新上报
- 默认连接本地 `127.0.0.1:1883`（与 Mosquitto 同机）；若网关发布到局域网内其他主机，在订阅页对应连接卡片中改地址即可
- 可同时配置**多条连接**（不同 broker / 不同主题），每条独立启用/停用；节点按**来源连接**分组显示在各卡片下（同一节点被多条连接上报时，归属最近一次上报的连接），身份仍由 `gateway_id` 区分
- 先手动验证链路（服务端只订阅「订阅主题」里配置的主题）：
  ```bash
  mosquitto_sub -h 127.0.0.1 -t '+/+/temperature' -v
  mosquitto_pub -h 127.0.0.1 -t gateway_1/node_5/temperature \
    -m '{"id":5,"name":"Node-1","temperature":26.5,"humidity":55,"battery":3.02,"rssi":-45}'
  ```

## MQTT 协议（分级主题 + 复合身份）

- Topic：`gateway_{gateway_id}/node_{device_id}/{device_type}`
  - `gateway_id`：网关 ID，由网关串口配置 `gateway.id` 设置（默认 0），每个场景（网关）一个
  - `device_id`：节点设备 ID（来自传感器 BLE 广播包）
  - `device_type`：节点设备类型，当前温湿度节点为 `temperature`，后续可扩展（如 `co2`、`door`）
- 节点以 **(gateway_id, device_id)** 复合身份存储：不同网关里可以有相同的 device_id
- 负载 JSON（身份以 topic 为准；topic 非 `gateway_/node_` 格式时回退用 payload `id`、`gateway_id=0`）：

```json
{"id":5,"name":"Node-1","temperature":26.52,"humidity":55,"battery":3.02,"rssi":-45}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| id | int | 节点设备 ID（与 gateway_id 复合定位，不再是单值主键） |
| name | string | 网关内置名称，可能为 "Unnamed"（可在订阅页改名覆盖） |
| temperature | float | 摄氏度 |
| humidity | int | 相对湿度 % |
| battery | float | 电池电压 V（ADC 未启用时可能为 0） |
| rssi | int | BLE 信号强度 dBm |

## API 一览

除 `/api/auth/*` 外，所有接口均需 `Authorization: Bearer <token>`（登录/注册后返回），未登录返回 401。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册（自动登录），`{"username","password"}`；用户名唯一 |
| POST | `/api/auth/login` | 登录，`{"username","password"}` → `{token, username, role, userId}` |
| POST | `/api/auth/logout` | 退出登录（删除会话） |
| GET | `/api/auth/me` | 校验当前 token → `{username, role, userId}` |
| GET | `/api/users` | （管理员）用户列表 |
| PUT | `/api/users/{id}/password` | （管理员）重置密码 `{"password"}` |
| DELETE | `/api/users/{id}` | （管理员）删除用户（级联清理其数据；不能删除自己/最后一个管理员） |
| GET | `/api/nodes?subscribed=true&gateway={id}` | 节点列表（可只列某网关；含订阅状态、最新数据、离线标记） |
| PUT | `/api/nodes/{gatewayId}/{deviceId}` | 设置订阅 / 修改显示名 `{"subscribed":true,"display_name":"主卧"}` |
| GET | `/api/telemetry/{gatewayId}/{deviceId}?limit=100` | 历史数据 |
| GET | `/api/layout` | 面板位置（遗留路由，基于节点 id，已不再被前端使用） |
| PUT | `/api/layout/{gatewayId}/{deviceId}` | 保存面板位置 `{"x":..,"y":..,"w":..,"h":..}`（遗留，%） |
| GET | `/api/panels` | 全部面板容器 + 节点小面板（含最新温湿度与离线标记） |
| POST | `/api/panels` | 创建空白面板容器 |
| PUT | `/api/panels/{id}` | 部分更新面板：改名 `{"name"}` 或锁定/解锁 `{"locked":true/false}`（锁定后其他修改被拒） |
| GET | `/api/panels/nodes` | 可添加的节点（全部已启用连接的订阅主题） |
| POST | `/api/panels/{panelId}/widgets` | 向面板添加节点小面板 `{"connection_id","topic"}`（同面板同主题去重） |
| PUT | `/api/panels/widgets/{id}` | 保存小面板像素坐标 `{"x","y","w","h"}` |
| DELETE | `/api/panels/widgets/{id}` | 删除节点小面板 |
| DELETE | `/api/panels/{id}` | 删除面板容器（其内小面板一并删除） |
| GET | `/api/settings` | 锁定状态 |
| PUT | `/api/settings` | 更新锁定状态 `{"lock_all":true}` |
| GET | `/api/status` | MQTT 连接、运行时间、节点数 |
| GET | `/api/mqtt` | 全部 MQTT 连接（每条含状态，不回传明文密码） |
| POST | `/api/mqtt` | 新建连接 `{"name","host","port","username?","password?","topics?","enabled?"}`，`topics` 为主题数组或逗号/换行分隔字符串 |
| PUT | `/api/mqtt/{id}` | 部分更新连接 `{"name"?,"host"?,"port"?,"username"?,"enabled"?,"topics"?,"password"?,"clear_password"?}`；缺省字段不改；`clear_password:true` 清除密码；保存后自动重连 |
| DELETE | `/api/mqtt/{id}` | 删除连接并断开 |

## 常见问题

- **订阅页某张卡片显示「未连接」**：在订阅页对应连接卡片中确认该 broker 的启用开关已打开、地址/端口/认证正确，保存后自动重连；卡片上的状态徽章和错误信息会标明是哪条连接连不上。确认网关能发布（用 `mosquitto_pub` 手动发一条验证）。
- **节点不出现**：服务端只订阅各连接「订阅主题」里配置的主题，默认空（不订阅任何主题）；先在对应连接的卡片里加上如 `+/+/temperature` 或具体节点的主题并保存。节点约 5 分钟一报，网关需用串口配置好 `gateway.id` 且 topic 需含合法 `node_<id>`。网关 `NODE_NAMES` 外的节点名显示为 "Unnamed"，可在订阅页改名。
- **主页面看不到某节点**：节点小面板不会自动生成，需在订阅页确认主题已订阅后，到主页面侧边栏展开目标面板 →「添加节点」选择该主题；连接停用后其小面板隐藏。
- **电池显示「—」**：该节点电池 ADC 未启用，上报 0V，属正常。
- **`npm install` 报 better-sqlite3 编译失败**：通常需要系统编译工具链（`sudo apt install build-essential python3`），或换用有预编译二进制的 Node 版本。
