# thermo-service 设计文档

全屋温湿度监控服务端（thermo-service）的架构与设计说明。本文档描述系统的整体结构、各模块职责、数据模型、关键设计决策与扩展方向，供后续维护与二次开发参考。

> 使用/部署指引见 [README.md](README.md)；本文档聚焦"为什么这样设计、各模块怎么工作"。

---

## 1. 项目概述

**目标**：订阅 MQTT broker 上各网关（BLE 网关）上报的温湿度节点数据，落库存储，并通过一个免构建的 Web 单页进行实时展示与配置管理。

**数据链路**：

```
sensor_node (BLE 广播)
      │  BLE
      ▼
ble_gateway (WiFi / MQTT publish, 约 5 分钟一报)
      │  MQTT  gateway_<gw>/node_<id>/<type>
      ▼
Mosquitto / 任意 broker
      │  SUBSCRIBE（支持 +/# 通配符）
      ▼
thermo-service ──► SQLite (better-sqlite3, WAL) ──► Express REST API ──► Vue 3 单页
```

**核心特性**：

- 支持**多条 MQTT 连接**（不同 broker / 不同主题），每条独立启用/停用，Web 端可增删改并自动重连，配置跨重启保留
- 节点以 **`(gateway_id, device_id)` 复合身份**存储，不同网关中可出现相同 device_id
- 订阅主题支持 `+` / `#` 通配符；节点身份优先从**主题**解析，兼容旧格式负载（回退用 payload 的 `id`）
- Web 端两级展示：**主页面**（面板容器 → 节点小面板，2560×1440 虚拟舞台自由布局）+ **订阅页面**（MQTT 连接 → 该连接上报的节点）
- 历史数据按保留天数自动清理；服务优雅退出

---

## 2. 技术选型与理由

| 组件 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js ≥ 18 | 与 mqtt.js / better-sqlite3 生态契合，单进程足够 |
| Web 框架 | Express 4 | 轻量、路由组织清晰，REST API + 静态资源一体 |
| MQTT 客户端 | mqtt.js 5 | 成熟的 Node MQTT 客户端，支持多连接、自动重连、通配符订阅 |
| 存储 | SQLite（better-sqlite3 12） | 单文件、零运维；**同步 API** 足够——消息量极小（每节点约 5 分钟一条），无需写线程/队列 |
| 前端 | Vue 3（CDN 全局版） | 免构建、单 HTML 即可运行，无需打包链路；部署即拷贝 |
| 文件上传 | multer（依赖中，预留） | 预留给背景图上传能力（当前未接线，见 §8.5） |

**并发模型**：单进程单线程 + 同步 SQLite。MQTT 消息到达即同步写库，吞吐量（~每 5 分钟 × 节点数）远低于 SQLite 单写能力，同步模型换来的是实现简单与强一致性。

---

## 3. 目录结构

```
service/
├── package.json / package-lock.json   # 依赖与锁文件
├── config.example.json                # 配置模板（提交进仓库）
├── config.json                        # 实际配置（git 忽略，首次部署时由模板复制）
├── server.js                          # 入口：Express 接线 + MQTT 启动 + 历史清理 + 优雅退出
├── config.js                          # 配置加载（深合并默认值，相对路径解析）
├── db.js                              # SQLite 数据访问层（建表 / 迁移 / CRUD / 落库 / 清理）
├── mqtt.js                            # MQTT 多连接管理器（订阅、解析校验、落库、路由）
├── routes/                            # REST 路由（nodes/telemetry/layout/panels/settings/status/mqtt）
│   └── mqtt.js                        #   —— 注意与根目录 mqtt.js 同名不同职责（HTTP vs MQTT）
├── public/                            # Vue 3 单页（index.html + app.js + style.css + uploads/）
├── data/                              # SQLite 数据库文件（运行时创建，git 忽略）
└── deploy/thermo-service.service      # Debian systemd 单元示例
```

**模块依赖关系**（仅展示服务端内部）：

```
server.js ──┬── config.js（配置）
            ├── db.js（数据访问）
            ├── mqtt.js（MQTT 管理器，依赖 db.js）
            └── routes/*（HTTP 路由，依赖 db.js 与 mqtt.js）
```

HTTP 侧与 MQTT 侧通过 `db.js` 共享同一份状态：消息落库后，Web 轮询读库即可拿到最新数据，无需额外的进程内事件总线。

---

## 4. 配置设计（config.js）

### 4.1 配置来源与优先级

1. **`config.json`**：用户实际配置，git 忽略。若存在则加载。
2. **`config.example.json`**：提交的模板，充当默认值。`config.json` 缺失时回退到它。
3. **代码内 `DEFAULTS`**（config.js）：最终兜底。

三者通过**深合并**（`deepMerge`）逐层覆盖：用户只写要改的字段即可，其余保持默认。

```json
{
  "mqtt":     { "host": "127.0.0.1", "port": 1883, "username": "", "password": "", "topics": [] },
  "database": { "path": "data/thermo.db", "retention_days": 30 },
  "server":   { "host": "0.0.0.0", "port": 8000 }
}
```

### 4.2 相对路径解析

所有相对路径（如 `database.path`）统一基于 `service/` 目录解析为绝对路径，避免运行时工作目录变化导致找不到库文件。

### 4.3 配置 vs 数据库职责划分（关键决策）

> **MQTT 连接以数据库（`mqtt_connections` 表）为准**，`config.json` 的 `mqtt.*` 仅在**全新数据库**时用于初始化第一条「默认连接」。

理由：MQTT 连接是**运行时动态管理**的配置（Web 端增删改、启用停用、主题列表），存库可以跨重启保留并支持多连接；`config.json` 更适合静态部署参数（监听地址/端口、保留天数）。启动初始化由 `db.migrateMqttConnections()` 完成，用 `mqtt_seeded` 标记保证幂等（用户删光全部连接后不重建）。

---

## 5. 数据模型（db.js）

### 5.1 表结构

| 表 | 作用 | 关键字段 / 约束 |
|---|---|---|
| `nodes` | 节点主表（最新状态） | 复合主键 `(gateway_id, device_id)`；`connection_id`（来源连接，可空）；`name`/`display_name`（显示名覆盖）；`device_type`；`subscribed`；`last_seen` 与 `last_temperature/humidity/battery/rssi` |
| `telemetry` | 温湿度历史 | 自增 `id`；`(gateway_id, node_id)` + 各采样值 + `received_at`；外键级联删除；索引 `(gateway_id, node_id, received_at)` |
| `panel_layouts` | 面板位置（**遗留**） | 按节点 id 存百分比坐标；新前端不再使用，保留兼容旧数据 |
| `settings` | 键值设置 | `key` 主键；存运行标记（迁移幂等标记）与全局设置（`background`、`lock_all`） |
| `mqtt_connections` | MQTT 连接配置 | `host/port/username/password`、`topics`（JSON 字符串：`[{topic,name,type}]`）、`enabled`（启用开关） |
| `panels` | **面板容器** | `id`、`name`、`locked`（锁定后禁止改名/删除/增删小面板） |
| `topic_panels` | **节点小面板** | `panel_id`（归属容器）、`connection_id`+`topic`（绑定订阅主题，均可空）、`type`（当前仅 `thermo`）、`x/y/w/h`（**像素坐标**）、实时缓存 `temperature/humidity/battery/rssi/last_seen`；唯一约束 `(panel_id, connection_id, topic)` |

### 5.2 设计要点

- **复合身份**：`nodes` 与 `telemetry` 都以 `(gateway_id, device_id)` 定位，允许多网关并行、同 device_id 不冲突。
- **缓存最新值**：`nodes.last_*` 与 `topic_panels.temperature/*` 均为"最近一条消息的缓存"，供列表/面板即时渲染，避免实时查询历史表。
- **`topic_panels` 可空 connection/topic**：SQLite 的 UNIQUE 视 NULL 为互异，因此 `(NULL, NULL)` 的空白占位面板可存在多张，而绑定主题的面板仍受唯一约束保护。
- **像素舞台坐标**：小面板 `x/y/w/h` 以 **2560×1440 虚拟舞台**（`STAGE_W`/`STAGE_H`，定义在 db.js，前端 app.js 与之保持一致）存储，前端渲染时等比缩放，与浏览器窗口大小无关，位置/尺寸不会随窗口变形。

### 5.3 迁移链（幂等）

`db.init()` 按序执行以下迁移，全部幂等（以 `settings` 标记或列存在性判断），可安全重入：

| 迁移 | 内容 | 幂等标记 |
|---|---|---|
| `migrateIfNeeded` | 旧库 `nodes` 单 `device_id` 主键 → 复合身份；补 `connection_id` 列 | 列存在性 |
| `migrateMqttConnections` | 旧扁平 `mqtt_host` 等设置键 → 一条「默认连接」 | `mqtt_seeded` |
| `migratePanelLayoutToPx` | 面板坐标 百分比 → 像素 | `layout_px` |
| `migrateTopicPanelsNullable` | `topic_panels` 的 connection/topic 允许 NULL | `topic_panels_nullable` |
| `migratePanelContainers` | 引入 `panels` 容器表，`topic_panels` 挂 `panel_id` | `panels_containers_v1` |
| `migratePanelLocked` | `panels` 增加 `locked` 列 | 列存在性 |

**关键 SQLite 选项**：`journal_mode = WAL`（读写并发友好）、`busy_timeout = 5000`。迁移中涉及多步 DDL/DML 的事务（`BEGIN`/`COMMIT`/`ROLLBACK`）保证原子性。

---

## 6. MQTT 模块（mqtt.js）

### 6.1 职责

管理**多条命名连接**的完整生命周期：连接、订阅、断线重连、配置变更重连、增量订阅、消息解析校验、落库与面板路由。连接配置从 `mqtt_connections` 表读取。

### 6.2 内部结构

`connections: Map<id, { client, connected, lastError, topics }>`——Map 保证按插入顺序遍历（与连接 id 顺序一致）。

**防陈旧回调守卫**（`guard()`）：连接被替换/删除后，旧 client 的迟到事件一律忽略，避免回调引用失效状态。这是沿用单连接时代 `client !== c` 模式的扩展。

### 6.3 消息处理流水线

```
onMessage(topic, payload, connectionId)
  └─ validate() 解析并校验
       ├─ 节点身份：优先从 topic 正则 /^gateway_(\d+)\/node_(\d+)\/([^/]+)$/ 解析
       │            （gateway_id、device_type 从主题来；id 从主题来）
       └─ 回退：主题不匹配旧格式时，gateway_id=0、device_type=''，id 取 payload.id
       └─ 范围校验（非法值一律置 null）：
            id ∈ [1, 65535]；gateway_id ∈ [0, 99999999]
            temperature ∈ [-50, 100]；humidity ∈ [0, 100]
            battery ∈ [0, 20]；rssi ∈ [-200, 20]
  ├─ db.upsertTelemetry(rec)
  │     └─ UPSERT nodes（最新状态）+ INSERT telemetry（历史）两条写
  └─ db.routeMessageToPanels(rec, topic, connectionId)
        └─ 按主题通配符（+ 单层 / # 剩余所有层，# 匹配零层亦可）匹配该连接下所有
           节点小面板，更新其缓存值，实现主页面实时刷新
```

**关键设计**：节点身份与"来自哪条连接"解耦——身份从主题/负载解析，`connection_id` 仅作来源记录（决定该节点显示在哪张连接卡片下）。同一节点被多条连接上报时，归属最近一次上报的连接。

### 6.4 订阅管理（增量 vs 重连）

- **主题变化**：`syncSubscriptions()` 对在线连接做**增量 SUBSCRIBE/UNSUBSCRIBE**，不重连；连接未启用/无存活客户端时仅改库，重连后按最新列表自然生效。
- **连接级参数变化**（地址/端口/账号/密码/启用开关）：`reconnectConnection()` 断开旧连接并按最新配置重连。

这个区分让"添加/删除主题"即时生效且不打断数据流，是 Web 端交互体验的关键。

### 6.5 状态上报

`status()` 汇总所有连接为 `{ connected, lastError, connections: [{id, connected, last_error}] }`，供 `/api/status` 与 `/api/mqtt` 使用。

---

## 7. REST API 设计

所有接口前缀 `/api`，返回 JSON；错误统一为 `{ "detail": "错误描述" }`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/nodes?subscribed=true&gateway={id}` | 节点列表（可过滤）；含订阅状态、最新数据、离线标记 `stale` |
| PUT | `/api/nodes/{gatewayId}/{deviceId}` | 设置订阅 / 修改显示名 `{"subscribed","display_name"}` |
| GET | `/api/telemetry/{gatewayId}/{deviceId}?limit=100` | 单节点历史（limit 夹取 1–1000） |
| GET | `/api/layout` | 遗留：基于节点 id 的百分比布局 |
| PUT | `/api/layout/{gatewayId}/{deviceId}` | 遗留：保存百分比布局（已不再被前端使用） |
| GET | `/api/panels` | 全部面板容器 + 节点小面板（含最新温湿度、离线标记） |
| POST | `/api/panels` | 创建空白面板容器 |
| PUT | `/api/panels/{id}` | 改名 `{"name"}` / 锁定解锁 `{"locked":true}`（锁定后其他修改 403） |
| DELETE | `/api/panels/{id}` | 删除面板容器（其内小面板一并删除） |
| GET | `/api/panels/nodes` | 可添加节点池（全部已启用连接的订阅主题） |
| POST | `/api/panels/{panelId}/widgets` | 向面板添加节点小面板 `{"connection_id","topic"}`（同面板同主题去重） |
| PUT | `/api/panels/widgets/{id}` | 保存小面板像素坐标 `{"x","y","w","h"}`（服务端夹取边界） |
| DELETE | `/api/panels/widgets/{id}` | 删除节点小面板 |
| GET | `/api/settings` | 全局锁定状态 `{lock_all}` |
| PUT | `/api/settings` | 更新全局锁定 `{"lock_all":true}` |
| GET | `/api/status` | MQTT 连接状态、运行时间、节点数 |
| GET | `/api/mqtt` | 全部 MQTT 连接（含连接状态；**不回传明文密码**，只回 `password_set`） |
| POST | `/api/mqtt` | 新建连接；`topics` 可为对象数组或逗号/换行分隔字符串 |
| PUT | `/api/mqtt/{id}` | 部分更新；`clear_password:true` 清除密码；主题变化增量订阅，连接级参数变化整体重连 |
| DELETE | `/api/mqtt/{id}` | 删除连接并断开，清理其节点小面板与来源关联 |

**校验与安全**：

- **主题合法性**：`#` 只能作最后一个完整层级，`+` 必须独占一个层级（前后端各实现一份，逻辑一致）。
- **数值夹取**：布局坐标在服务端做边界夹取（`clamp`），前端再做 10px 网格吸附。
- **密码保护**：明文密码只写入/更新，绝不回读；列表接口仅返回 `password_set` 布尔。
- **离线判定**：`last_seen` 距今超过 **10 分钟** 标记 `stale`（`PANEL_STALE_AFTER_MS`，前后端常量一致）。

---

## 8. 前端设计（public/）

### 8.1 形态

Vue 3 全局版（CDN 引入，`vue.global.prod.js`），无构建步骤。`index.html` 定义模板，`app.js` 定义逻辑，`style.css` 定义样式。

### 8.2 数据刷新

**10 秒轮询**（`POLL_INTERVAL`）：`refreshAll()` 并发拉取 `/api/nodes`、`/api/panels`、`/api/panels/nodes`；仅在订阅页时额外拉 `/api/mqtt`。节点约 5 分钟一报，10s 轮询足够实时且开销可忽略。轮询用 `refreshing` 标志去重，避免请求堆叠。

### 8.3 两个 Tab

- **主页面**：主舞台一次显示一个**面板容器**。容器内节点小面板按 `x/y/w/h` **绝对定位**在等比缩放的虚拟舞台（2560×1440）上，解锁时支持拖拽移动、右下角手柄缩放，位移/尺寸吸附 10px 网格，落手后 PUT 保存。右侧边栏为面板管理表（二级：面板 → 小面板），支持增删改、锁定/解锁、添加节点下拉。
- **订阅页面**：每条 **MQTT 连接**一张卡片，内含服务器配置（可折叠）与该连接上报的节点列表；顶部「＋ 添加服务器」。主题的增删即时提交（`applyTopics` 串行链保证同一连接的多次修改不乱序覆盖）。

### 8.4 交互细节

- **自动摆开**（`autoPlaceWidgets`）：旧数据或新添加的小面板若坐标重叠，前端自动按网格摆开并持久化（锁定面板不自动改布局）。
- **编辑不被打断**：轮询刷新连接列表时只更新状态字段（`connected`/`last_error`/`password_set`），不清空用户正在编辑的表单（密码输入、主题输入等瞬态字段保留）。
- **拖拽中不覆盖**：小面板拖拽进行中跳过 `refreshPanels` 对本地坐标的覆盖，落手后统一保存。

---

## 9. 关键设计决策总结

| # | 决策 | 取舍 / 理由 |
|---|---|---|
| 1 | SQLite 同步写库，不引入队列/写线程 | 消息量极小；实现最简单，数据强一致 |
| 2 | `(gateway_id, device_id)` 复合身份 | 多网关场景下 device_id 可重复，单值主键不够 |
| 3 | 节点身份优先从**主题**解析 | 主题本身就是分级标准；对旧格式负载做 `payload.id` 回退，向后兼容 |
| 4 | MQTT 连接配置存库、Web 端管理 | 运行时动态配置跨重启保留、支持多连接；`config.json` 只做全新库种子 |
| 5 | 面板采用「容器 + 小面板」两级模型 | 一个舞台一次展示一个场景（面板），场景内自由布局节点卡片 |
| 6 | 坐标用 2560×1440 像素舞台而非百分比 | 分辨率无关、精确到像素，缩放渲染不变形 |
| 7 | 面板锁定（`locked`）/ 全局锁定（`lock_all`） | 部署为大屏/展示用途时防止误操作 |
| 8 | 主题变更增量订阅、连接级变更才重连 | 常用操作（加主题）即时生效、不打断数据流 |
| 9 | 前端免构建（Vue CDN） | 部署即拷贝，无编译/构建步骤，契合单机小规模部署 |
| 10 | 10 分钟无上报判定离线 | 节点约 5 分钟一报，容忍一跳未达；常量前后端保持一致 |
| 11 | 优雅退出（SIGINT/SIGTERM） | 断开 MQTT、关闭 HTTP，2s 兜底强制退出 |
| 12 | 历史数据每日清理 | `retention_days` 配置，`0` 关闭；用 ISO 字符串比较保证与存储格式一致 |

---

## 10. 部署与运维

- **进程**：`node server.js`（或 `npm start`），systemd 示例见 `deploy/thermo-service.service`（`Type=simple`，`Restart=on-failure`，`RestartSec=5`）。
- **依赖顺序**：`After=network-online.target mosquitto.service`；若 broker 在私网，可加 `Requires=network-online.target` 保证 DNS 就绪。
- **日志**：`journalctl -u thermo-service -f`。
- **数据文件**：`data/thermo.db`（WAL，附带 `-shm`/`-wal`）。升级前建议备份；`backup_pre_px_migration/` 展示了迁移前的备份习惯。
- **节点验证链路**：`mosquitto_sub -t '+/+/temperature' -v` + `mosquitto_pub` 手动发布一条，确认订阅→落库→展示全链路。

---

## 11. 边界与待办

- **`type` 仅支持 `thermo`**：`switch`（开关）类型在 schema 与 UI 中预留，渲染为"待支持"占位，需扩展消息解析与面板渲染。
- **背景图上传未接线**：`multer` 依赖与 `settings.background` 字段已存在、`public/uploads/` 已就位，但当前无上传路由，`storage.*` 配置也未在 `config.js` 默认值中生效；属预留能力。
- **`panel_layouts` 表为遗留**：基于节点 id 的百分比布局已不再被前端使用，保留仅为旧数据兼容，未来可清理。
- **无鉴权**：服务面向内网/家庭环境，API 未做认证。若暴露公网需在反向代理层增加 Basic Auth / 网络白名单。
- **单进程部署**：未做多实例/负载均衡；单机小规模场景足够，不做横向扩展设计。

---

## 12. 扩展方向

1. **新设备类型**：在 `validate()` 中解析更多字段（如 `co2`），扩展 `type` 与面板渲染分支。
2. **WebSocket / SSE 推送**：替代 10s 轮询，实现真正实时刷新（当前轮询已足够，非必需）。
3. **告警规则**：温度越界 / 长时间离线告警，复用 `settings` 键值 + 历史清理定时器模式。
4. **鉴权与多用户**：增加登录与只读/可编辑权限分层，配合公网部署。
5. **数据导出**：按节点/时间段导出 CSV/JSON，供数据分析。
