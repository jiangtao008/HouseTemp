#!/usr/bin/env bash
# =============================================================
# 全屋温湿度监控服务端 — Debian 部署脚本
#
# 功能：
#   1. 将 service/ 代码拷贝到 /srv/thermo-service
#   2. 初始化 config.json（已存在则保留）
#   3. npm install（失败时自动补装编译工具链）
#   4. 创建系统用户 thermo 并授权
#   5. 注册 systemd 服务并启动
#
# 用法（在 Debian 服务器上执行）：
#   方式一：先在服务器上放好代码，然后
#     cd /path/to/service
#     sudo bash deploy/deploy.sh
#   方式二：指定源码目录
#     sudo bash deploy/deploy.sh /path/to/service
#
# 从 macOS 上传代码（可选）：
#   scp -r service/ user@server:/tmp/thermo-service/
#   ssh user@server "cd /tmp/thermo-service && sudo bash deploy/deploy.sh"
#
# 查看日志：journalctl -u thermo-service -f
# =============================================================
set -euo pipefail

APP_DIR="/srv/thermo-service"
APP_USER="thermo"

# ---------- 基本检查 ----------
if [ "$(id -u)" -ne 0 ]; then
  echo "错误：请用 root 运行（sudo bash deploy/deploy.sh）" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 源码目录：优先命令行参数 > 脚本父目录（即 service/） > 当前目录
SOURCE_DIR="${1:-}"
if [ -z "$SOURCE_DIR" ]; then
  if [ -f "$SCRIPT_DIR/../server.js" ]; then
    SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  else
    SOURCE_DIR="$(pwd)"
  fi
fi
SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"

if [ ! -f "$SOURCE_DIR/server.js" ]; then
  echo "错误：$SOURCE_DIR 下找不到 server.js，请确认源码目录正确" >&2
  exit 1
fi

echo "▸ 源码目录 : $SOURCE_DIR"
echo "▸ 安装目录 : $APP_DIR"

# ---------- 检查 Node.js ----------
echo "▸ 检查 Node.js ..."
if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node，请先安装 Node.js >= 18（Debian 12 自带 nodejs 18）" >&2
  echo "  sudo apt update && sudo apt install -y nodejs npm" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "错误：当前 Node.js $(node --version) 版本过低，需要 >= 18（Debian 11 及以下需换源升级）" >&2
  exit 1
fi
echo "   ✓ Node.js $(node --version)"

# ---------- 拷贝代码 ----------
if [ "$SOURCE_DIR" = "$APP_DIR" ]; then
  echo "▸ 源码已在 $APP_DIR（如 clone 到此目录），跳过拷贝"
else
  echo "▸ 拷贝代码到 $APP_DIR ..."
  mkdir -p "$APP_DIR"
  if command -v rsync >/dev/null 2>&1; then
    # --delete 保证目标干净；data/、uploads/（用户上传的头像）、node_modules、日志、
    # macOS 垃圾文件不参与同步（--exclude 的目录在目标端不会被 --delete 误删，重跑安全）
    rsync -a --delete \
      --exclude 'node_modules/' \
      --exclude 'data/' \
      --exclude 'public/uploads/' \
      --exclude 'server.log' \
      --exclude '.DS_Store' \
      "$SOURCE_DIR/" "$APP_DIR/"
  else
    echo "  ! 未安装 rsync，改用 cp（不会清理目标多余文件，建议 apt install rsync）"
    cp -r "$SOURCE_DIR"/. "$APP_DIR/" 2>/dev/null || true
    rm -rf "$APP_DIR/node_modules" "$APP_DIR/data" "$APP_DIR/server.log" "$APP_DIR/.DS_Store"
  fi
fi

# ---------- 初始化 config.json ----------
if [ -f "$APP_DIR/config.json" ]; then
  echo "▸ config.json 已存在，保留现有配置"
else
  cp "$APP_DIR/config.example.json" "$APP_DIR/config.json"
  echo "▸ 已从 config.example.json 生成 config.json"
  echo "   ! 请编辑 $APP_DIR/config.json 设置 admin 密码与 MQTT 配置"
fi

# ---------- 安装 npm 依赖 ----------
echo "▸ 安装 npm 依赖 ..."
cd "$APP_DIR"
ERR_LOG="$(mktemp)"
if ! npm install --omit=dev --no-fund --no-audit 2>"$ERR_LOG"; then
  echo "  ! npm install 失败，可能缺少 better-sqlite3 编译工具链" >&2
  tail -n 20 "$ERR_LOG" >&2
  echo "  正在安装 build-essential python3 后重试 ..." >&2
  apt-get update -y
  apt-get install -y build-essential python3
  rm -f "$ERR_LOG"
  npm install --omit=dev --no-fund --no-audit
fi
rm -f "$ERR_LOG"

# ---------- 创建系统用户 ----------
echo "▸ 创建系统用户 $APP_USER ..."
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod -R u+rwX,u-s,go-rwX "$APP_DIR"

# ---------- 注册 systemd 服务 ----------
echo "▸ 注册并启动 systemd 服务 ..."
# 若 node 不在 /usr/bin（如 nvm），修正单元文件中的 ExecStart 路径
NODE_BIN="$(command -v node)"
UNIT="/etc/systemd/system/thermo-service.service"
cp "$APP_DIR/deploy/thermo-service.service" "$UNIT"
if [ "$NODE_BIN" != "/usr/bin/node" ]; then
  echo "  ! node 位于 $NODE_BIN，修正 systemd 单元中的 ExecStart"
  sed -i "s#ExecStart=.*#ExecStart=$NODE_BIN $APP_DIR/server.js#" "$UNIT"
fi
systemctl daemon-reload
systemctl enable --now thermo-service
sleep 1

# ---------- 防火墙提示 ----------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "▸ 检测到 ufw 已启用，放行 8000 端口 ..."
  ufw allow 8000/tcp
fi

# ---------- 结果 ----------
echo ""
echo "======================================================"
echo " 部署完成"
echo "======================================================"
systemctl --no-pager --lines=10 status thermo-service || true
echo ""
echo "访问地址：http://$(hostname -I | awk '{print $1}'):8000/"
echo "日志查看：journalctl -u thermo-service -f"
echo ""
echo "下一步："
echo "  1) 确认 $APP_DIR/config.json 中 admin 密码已设置（若沿用示例则为空，不会创建管理员）"
echo "  2) 若网关上报到非本机 broker，登录后在「订阅页」的 MQTT 连接卡片中改地址"
echo "  3) 本脚本不安装 Mosquitto；如需同机部署 broker："
echo "     sudo apt install -y mosquitto mosquitto-clients"
