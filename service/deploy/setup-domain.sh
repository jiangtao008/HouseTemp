#!/usr/bin/env bash
# =============================================================
# 全屋温湿度监控服务端 — 域名 / HTTPS 部署脚本（支持多域名）
#
# 前置条件：
#   1. 已在 DNS 服务商把每个域名的 A 记录解析到本机公网 IP
#   2. 以 root 运行（sudo）
#
# 功能：
#   1. 检查域名解析（未解析则中止，避免 certbot 白跑）
#   2. 生成 Nginx 反向代理站点（缺省时自动安装 Nginx）
#   3. 签发 Let's Encrypt 证书（所有域名一张证书），启用 HTTPS 并强制跳转
#
# 用法：
#   sudo bash deploy/setup-domain.sh <域名...> <邮箱>
#   邮箱可选（含 @ 的参数自动识别为邮箱）；省略时交互式输入或使用免注册模式。
#
#   示例（根域名 + www）：
#   sudo bash deploy/setup-domain.sh suiyiyuming.site www.suiyiyuming.site
#
# 前置脚本：bash deploy/deploy.sh（部署服务端应用本身）
# =============================================================
set -euo pipefail

# ---------- 参数解析：含 @ 的是邮箱，其余都是域名 ----------
DOMAINS=()
EMAIL=""
for arg in "$@"; do
  if [[ "$arg" == *"@"* ]]; then
    EMAIL="$arg"
  else
    DOMAINS+=("$arg")
  fi
done

if [ "$(id -u)" -ne 0 ]; then
  echo "错误：请用 root 运行（sudo bash deploy/setup-domain.sh <域名...> <邮箱>）" >&2
  exit 1
fi

if [ "${#DOMAINS[@]}" -eq 0 ]; then
  read -rp "请输入域名（多个用空格分隔，如 suiyiyuming.site www.suiyiyuming.site）: " -r line
  # shellcheck disable=SC2206
  DOMAINS=($line)
fi
if [ "${#DOMAINS[@]}" -eq 0 ]; then
  echo "错误：未提供域名" >&2
  exit 1
fi
if [ -z "$EMAIL" ]; then
  read -rp "请输入 Let's Encrypt 邮箱（证书过期提醒，可留空）: " EMAIL
fi

PRIMARY="${DOMAINS[0]}"
SERVER_NAMES="${DOMAINS[*]}"            # 空格拼接，供 server_name 使用
CERT_ARGS=()
for d in "${DOMAINS[@]}"; do
  CERT_ARGS+=(-d "$d")
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/nginx-thermo.conf"
SITE_FILE="/etc/nginx/sites-available/thermo"

echo "▸ 目标域名 : ${DOMAINS[*]}"
echo "▸ 主域名   : $PRIMARY"

# ---------- 1. DNS 解析检查 ----------
echo "▸ 检查域名解析 ..."
for d in "${DOMAINS[@]}"; do
  if ! getent hosts "$d" >/dev/null 2>&1; then
    echo "错误：$d 未能解析到 IP。" >&2
    echo "  请先在 DNS 服务商配置 A 记录指向本机公网 IP，等生效后再运行。" >&2
    echo "  验证命令：dig $d +short（应返回公网 IP）" >&2
    exit 1
  fi
done
# 获取本机出口公网 IP（尽力而为，失败不阻断）
PUBLIC_IP=""
for URL in "https://api.ipify.org" "https://ifconfig.me/ip" "https://ipv4.icanhazip.com"; do
  if PUBLIC_IP="$(curl -fsS --max-time 5 "$URL" 2>/dev/null | tr -d '\n')" && [ -n "$PUBLIC_IP" ]; then
    break
  fi
done
if [ -n "$PUBLIC_IP" ]; then
  RESOLVED="$(getent ahostsv4 "$PRIMARY" | awk '{print $1}' | sort -u | tr '\n' ' ')"
  echo "  出口公网 IP : $PUBLIC_IP"
  echo "  $PRIMARY 解析到 : ${RESOLVED:-（无 IPv4 记录）}"
  if [ -n "$RESOLVED" ] && ! echo "$RESOLVED" | grep -q "$PUBLIC_IP"; then
    echo "  ! 警告：域名解析的 IP 与当前出口公网 IP 不一致。" >&2
    echo "    可能是多 A 记录 / CDN / DNS 未同步。certbot 若失败请先检查解析。" >&2
  fi
else
  echo "  ! 无法获取本机公网 IP（跳过一致性比对）"
fi

# ---------- 2. Nginx ----------
echo "▸ 检查 Nginx ..."
if ! command -v nginx >/dev/null 2>&1; then
  echo "  安装 nginx ..."
  apt-get update -y
  apt-get install -y nginx
fi
echo "   ✓ $(nginx -v 2>&1)"

echo "▸ 生成反向代理站点配置 ..."
if [ -f "$TEMPLATE" ]; then
  # 直接替换 server_name 一整行，不依赖模板里的占位符
  sed -E "s/^([[:space:]]*server_name[[:space:]]+)[^;]*;/\1${SERVER_NAMES};/" "$TEMPLATE" > "$SITE_FILE"
else
  cat > "$SITE_FILE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $SERVER_NAMES;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
fi
ln -sf "$SITE_FILE" /etc/nginx/sites-enabled/thermo
nginx -t
systemctl reload nginx
echo "   ✓ 反向代理已生效：http://$SERVER_NAMES 应可访问监控页"

# ---------- 3. HTTPS ----------
echo "▸ 检查 certbot ..."
if ! command -v certbot >/dev/null 2>&1; then
  apt-get install -y certbot python3-certbot-nginx
fi
echo "▸ 签发 HTTPS 证书（${DOMAINS[*]}）..."
if [ -n "$EMAIL" ]; then
  certbot --nginx "${CERT_ARGS[@]}" --non-interactive --agree-tos -m "$EMAIL" --redirect
else
  echo "  ! 未提供邮箱，使用免注册模式（证书无过期邮件提醒）"
  certbot --nginx "${CERT_ARGS[@]}" --non-interactive --agree-tos --register-unsafely-without-email --redirect
fi
echo "   ✓ HTTPS 已启用：https://$PRIMARY（自动跳转至 HTTPS）"

# ---------- 可选加固 ----------
echo ""
if read -rp "是否将 8000 端口限制为仅本机可访问（关闭 http://IP:8000）? [y/N] " ans; then
  case "$ans" in
    y|Y|yes|YES)
      if command -v ufw >/dev/null 2>&1; then
        ufw allow 80/tcp 443/tcp
        ufw allow OpenSSH
        ufw --force enable
        ufw deny 8000/tcp
        echo "   ✓ 8000 端口已限制为本机访问（Nginx 经 127.0.0.1 不受影响）"
      else
        echo "  ! 未检测到 ufw，跳过（可选：iptables -I INPUT -p tcp --dport 8000 -j REJECT）"
      fi
      ;;
  esac
fi

echo ""
echo "======================================================"
echo " 部署完成"
echo "  访问  ：https://$PRIMARY  /  https://${DOMAINS[*]}"
echo "  续期  ：certbot renew（systemd 定时器已自动配置，无需手动）"
echo "  日志  ：journalctl -u thermo-service -f"
echo "======================================================"
