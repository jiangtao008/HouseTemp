# 全屋温湿度监控服务端 — Debian 部署记录

> 部署时间：2026-08-16
> 关联脚本：本目录下的 `deploy.sh` / `setup-domain.sh` / `nginx-thermo.conf` / `thermo-service.service`

## 〇、常用命令速查

```bash
sudo systemctl restart thermo-service            # 重启
journalctl -u thermo-service -f                  # 看实时日志
systemctl status thermo-service                  # 看状态
```

补充：停止 / 启动 / 重载 Nginx

```bash
sudo systemctl stop thermo-service               # 停止
sudo systemctl start thermo-service              # 启动
sudo nginx -t && sudo systemctl reload nginx     # 校验并重载 Nginx
```

---

## 一、环境总览

| 项 | 值 |
|---|---|
| 服务器 | 腾讯云 VPS · Debian · 主机名 `VM-0-14-debian` |
| 公网 IP | `118.89.133.140` |
| 内网 IP | `10.0.0.14` |
| 域名 | `suiyiyuming.site`（根） / `www.suiyiyuming.site` |
| DNS 服务商 | DNSPod（腾讯云） |
| Node.js | v20.20.2 |
| Nginx | 1.26.3 |
| 应用目录 | `/srv/thermo-service` |
| systemd 服务 | `thermo-service.service`（运行用户 `thermo`） |
| Web 访问 | `https://suiyiyuming.site` |
| 代码仓库 | <https://github.com/jiangtao008/HouseTemp.git>（服务器上 clone 至 `~/HouseTemp`） |

### 数据链路

```text
sensor_node（BLE 广播）→ ble_gateway（WiFi/MQTT 上报）
    → Mosquitto Broker → 本服务（订阅 → SQLite 落库）→ Web 展示
```

---

## 二、部署文件清单

`service/deploy/` 下共 4 个文件：

| 文件 | 作用 | 何时使用 |
|---|---|---|
| `deploy.sh` | 服务端主部署：拷代码、装依赖、建用户、注册 systemd 并启动 | 首次部署 / 代码更新后 |
| `setup-domain.sh` | 绑定域名 + HTTPS：检查 DNS、生成 Nginx 反代、签发证书 | 首次配域名 / 换域名 |
| `nginx-thermo.conf` | Nginx 反向代理模板（被 `setup-domain.sh` 读取并替换 `server_name`） | 模板，一般不改 |
| `thermo-service.service` | systemd 单元定义（被 `deploy.sh` 安装到 `/etc/systemd/system/`） | 模板，一般不改 |

### 服务器上的关键路径

| 路径 | 内容 |
|---|---|
| `/srv/thermo-service` | 应用运行目录（部署目标） |
| `/srv/thermo-service/config.json` | 运行时配置（**git 忽略，clone 不包含**，首次部署自动从 example 生成） |
| `/srv/thermo-service/data/thermo.db` | SQLite 数据库（运行时生成，重跑部署不会覆盖） |
| `/etc/nginx/sites-available/thermo` | Nginx 站点配置（软链到 sites-enabled） |
| `/etc/systemd/system/thermo-service.service` | systemd 服务文件 |
| `/root` 下的 `~/HouseTemp` | 代码 clone 目录（git pull 更新代码用） |

---

## 三、部署步骤（完整复现）

### 1. clone 代码（服务器上）

```bash
cd /opt   # 或任意稳定位置
git clone https://github.com/jiangtao008/HouseTemp.git thermo
cd thermo/service
```

### 2. 部署服务端

```bash
sudo bash deploy.sh
```

脚本自动完成：检查 Node ≥ 18 → 拷贝代码到 `/srv/thermo-service`（rsync，排除 `data/`、`node_modules/`）→ 无 `config.json` 时从 example 生成 → `npm install --omit=dev`（编译失败自动补装工具链）→ 创建系统用户 `thermo` → 注册并启动 systemd 服务。

> ⚠️ **必须做**：clone 下来的仓库没有 `config.json`（git 忽略）。部署后编辑并设置 admin 密码：
>
> ```bash
> sudo vim /srv/thermo-service/config.json
> # 至少配置：
> #   "admin": { "username": "admin", "password": "你的密码" }
> #   "mqtt":  { "host": "broker 地址", ... }
> sudo systemctl restart thermo-service
> ```
>
> 只有 username 和 password **都不为空**才会创建管理员账号（`ensureAdmin` 逻辑）。

### 3. 绑定域名 + HTTPS

```bash
sudo bash setup-domain.sh suiyiyuming.site www.suiyiyuming.site
```

脚本自动完成：检查域名解析 → 生成 Nginx 反代站点 → 安装 certbot → 签发覆盖所有域名的 Let's Encrypt 证书 → HTTP 自动跳 HTTPS → （交互）询问是否用 ufw 关闭 8000 裸端口。

> 邮箱为可选参数（含 `@` 自动识别）；省略时交互式输入或使用免注册模式。

---

## 四、Nginx / HTTPS / 防火墙配置

### Nginx 站点（`/etc/nginx/sites-available/thermo`）

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name suiyiyuming.site www.suiyiyuming.site;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### HTTPS

- 证书：Let's Encrypt，一张证书覆盖 `suiyiyuming.site` + `www.suiyiyuming.site`
- 端口 80 自动 301 跳转 443
- 自动续期：certbot 已配置 systemd 定时器，无需手动
- 手动续期/查状态：`sudo certbot renew --dry-run` / `sudo certbot certificates`

### 防火墙（ufw，已启用）

```bash
sudo ufw status verbose
# 80,443/tcp ALLOW    # Nginx
# OpenSSH     ALLOW    # SSH
# 8000/tcp    DENY     # 关闭裸端口，仅本机回环可访问（Nginx 经 127.0.0.1 不受影响）
```

如需恢复直连 8000：`sudo ufw delete deny 8000/tcp`

---

## 五、验证清单（部署完成后核对）

```bash
# 1. 服务运行状态
sudo systemctl status thermo-service        # active (running)

# 2. HTTPS 正常（公网）
curl -sI https://suiyiyuming.site/ | head -1     # HTTP/1.1 200 OK
curl -sI https://www.suiyiyuming.site/ | head -1 # HTTP/1.1 200 OK

# 3. HTTP 自动跳转
curl -sI http://suiyiyuming.site/ | head -1      # HTTP/1.1 301 Moved Permanently

# 4. 8000 裸端口已关闭
curl -sI http://118.89.133.140:8000/ --max-time 5 # 超时 / 无响应

# 5. 查看日志
journalctl -u thermo-service -f
```

浏览器访问 `https://suiyiyuming.site`，用 admin + 配置的密码登录。

---

## 六、日常维护

### 更新代码

```bash
cd ~/HouseTemp && git pull
cd service && sudo bash deploy/deploy.sh    # 重新同步 + 重启，data/ 与 config.json 保留
```

### 重启 / 停止 / 查看日志

```bash
sudo systemctl restart thermo-service
sudo systemctl stop thermo-service
journalctl -u thermo-service -f             # 实时日志
```

### 修改 Nginx 反代参数

改 `service/deploy/nginx-thermo.conf` 后，重新执行 `setup-domain.sh`，或手动：

```bash
sudo vim /etc/nginx/sites-available/thermo
sudo nginx -t && sudo systemctl reload nginx
```

---

## 七、踩坑与排查记录

### 1. 浏览器一直跳 `/imageTao/`（旧部署残留）

- **现象**：访问 `https://www.suiyiyuming.site/` 总是被带到 `/imageTao/`，页面显示 `Cannot GET /imageTao/`。
- **根因**：该域名此前部署过带 `/imageTao/` 后缀的旧应用；即使服务器上已删除，**浏览器缓存的旧 301 跳转**依然生效。服务器端验证正常（根路径 200、`/imageTao` 404），非服务问题。
- **定位**：访问 `https://www.suiyiyuming.site/?t=1`（加参数绕过缓存）→ 能打开即确认是缓存跳转。
- **修复**：
  1. 关掉该站点所有标签页
  2. `chrome://settings/clearBrowserData` → 时间范围**全部时间** → 勾选**缓存的图片和文件** → 清除
  3. 完全退出 Chrome 重开
  - 注意：DevTools 的 "Clear site data" **清不掉 HTTP 缓存的 301**，必须用主设置清除。
  - 临时绕过：用不带 www 的 `https://suiyiyuming.site/` 或 `?t=1`。
  - 若仍无效，查 Service Worker（DevTools → Application → Service Workers → Unregister）或禁用浏览器插件。

### 2. ufw 多端口写法报错 `Need 'to' or 'from' clause`

- `ufw allow 80/tcp 443/tcp` 是**错误**写法（多端口需逗号），会报错。
- 正确：`sudo ufw allow 80,443/tcp`
- 已修复到 `setup-domain.sh` 中。

### 3. 出口公网 IP 报 IPv6 误报

- `curl https://api.ipify.org` 在双栈机器上可能返回 IPv6，与 A 记录比对误报"IP 不一致"。
- 已修复：脚本中 `curl` 强制 `-4`，只查 IPv4。

### 4. config.json 是 git 忽略文件

- clone 下来的仓库**没有** `config.json`，首次部署由 `deploy.sh` 从 `config.example.json` 生成。
- 生成的是空配置（admin 密码为空、MQTT 127.0.0.1），**必须手动编辑设置**，否则不会创建管理员账号。

### 5. 服务器未安装 rsync

- `deploy.sh` 在无 rsync 时自动回退用 `cp`（可用，但旧文件不清理）。
- 建议安装：`sudo apt install -y rsync`，更新更干净。

---

## 八、遗留待办

- [ ] **MQTT 数据链路**：服务器上**尚未安装/配置 Mosquitto**。新库会自动种一条指向 `127.0.0.1:1883` 的默认连接，因本机无 broker 会显示"未连接"（正常）。待网关上报时：
  - 同机部署 broker：`sudo apt install -y mosquitto mosquitto-clients`
  - 或登录后在「订阅页」改默认连接地址 / 新建连接
- [ ] **代码同步**：`service/deploy/` 的脚本改动（`deploy.sh` 的拷贝保护、`setup-domain.sh` 的 ufw 修复与 IPv4 检测、`nginx-thermo.conf` 模板）**尚未 commit + push**，服务器 clone 落后，需推送后 `git pull` 对齐。
- [ ] **安装 rsync**（见踩坑 #5）
- [ ] 确认 Let's Encrypt 邮箱已绑定（避免续期失败无通知）：`sudo certbot update_account --email 你的邮箱`（如已填可忽略）
