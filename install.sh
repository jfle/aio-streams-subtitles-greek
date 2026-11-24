#!/usr/bin/env bash
# AIO-Streams&Subtitles-Greek installer — Debian / Ubuntu / Raspberry Pi OS / Armbian (amd64, arm64, armhf).
#
#   sudo ./install.sh                  install or update (keeps settings, cache and sign-ins)
#   sudo ./install.sh --https none     plain HTTP only (Stremio desktop on your LAN)
#   sudo ./install.sh --port 7100      use another port for the addon
#   sudo ./install.sh --public-ip auto [--public-port 8443]
#                                      also reachable outside your home network: public IP (auto-detected,
#                                      or give it) + the port you forward on your router
#   sudo ./install.sh --public-url https://subs.example.com
#                                      also reachable at your own domain / tunnel (it provides HTTPS)
#   sudo ./install.sh --no-public      home network only again
#   sudo ./install.sh --password PW    set the configuration-page password (generated when going public)
#   sudo ./install.sh --no-aiostreams  subtitle addon only (skip / remove the bundled AIOStreams)
#   sudo ./install.sh --aio-port 8444 [--aio-public-port 8444]
#                                      HTTPS port for AIOStreams (and the router port for outside access)
#   sudo ./install.sh --aio-public-url https://streams.example.com
#                                      public HTTPS base for bundled AIOStreams behind a tunnel
#   sudo ./install.sh --uninstall      remove the service (keeps data); add --purge to delete data too
#
# After installing, open the printed address, configure your AI provider and click "Install in Stremio".
set -euo pipefail

APP=aio-streams-subtitles-greek
NAME="AIO-Streams&Subtitles-Greek"
DIR=/opt/$APP
SVC_USER=aigreeksubs
PORT=7000
HTTPS=localip          # localip = HTTPS on your LAN via <ip>.local-ip.sh + nginx ; none = HTTP only
UNINSTALL=0
PURGE=0
OLD_DIRS=(/opt/ai-greek-subs-fletouris /opt/stremio-ai-subtitle-translator)
OLD_SERVICES=(ai-greek-subs-fletouris stremio-ai-subtitles)
OLD_SITES=(ai-greek-subs-fletouris stremio-ai-subtitles)
OLD_CONF=/etc/ai-greek-subs-fletouris   # settings of the previous name (.conf / .env)
AIO_DIR=/opt/aiostreams
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF=/etc/$APP.conf      # settings remembered between updates (root only)
ENVFILE=/etc/$APP.env    # secrets for the service (root only)
PUBLIC_IP=""; PUBLIC_PORT=""; PUBLIC_URL_EXT=""; CONFIG_PASSWORD=""
AIOSTREAMS=1; AIO_PORT=8444; AIO_PUBLIC_PORT=""; AIO_PUBLIC_URL=""; AIO_USER="admin"
# Settings from the previous project name are picked up once, then saved under the new name.
[[ ! -r "$CONF" && -r "$OLD_CONF.conf" ]] && CONF_SRC="$OLD_CONF.conf" || CONF_SRC="$CONF"
[[ ! -r "$ENVFILE" && -r "$OLD_CONF.env" ]] && ENV_SRC="$OLD_CONF.env" || ENV_SRC="$ENVFILE"
# shellcheck disable=SC1090
[[ -r "$CONF_SRC" ]] && . "$CONF_SRC"
[[ -r "$ENV_SRC" ]] && CONFIG_PASSWORD=$(sed -n 's/^CONFIG_PASSWORD=//p' "$ENV_SRC" | head -1)

c_b=$'\e[1;34m'; c_g=$'\e[1;32m'; c_y=$'\e[1;33m'; c_r=$'\e[1;31m'; c_0=$'\e[0m'
step() { echo "${c_b}==>${c_0} $*"; }
ok()   { echo "${c_g} ✓${c_0} $*"; }
warn() { echo "${c_y} !${c_0} $*"; }
die()  { echo "${c_r} ✗ $*${c_0}" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --https) HTTPS="$2"; shift 2 ;;
    --public-ip) PUBLIC_IP="$2"; PUBLIC_URL_EXT=""; shift 2 ;;
    --public-port) PUBLIC_PORT="$2"; shift 2 ;;
    --public-url) PUBLIC_URL_EXT="${2%/}"; PUBLIC_IP=""; shift 2 ;;
    --no-public) PUBLIC_IP=""; PUBLIC_PORT=""; PUBLIC_URL_EXT=""; AIO_PUBLIC_URL=""; shift ;;
    --password) CONFIG_PASSWORD="$2"; shift 2 ;;
    --no-aiostreams) AIOSTREAMS=0; shift ;;
    --with-aiostreams) AIOSTREAMS=1; shift ;;
    --aio-port) AIO_PORT="$2"; shift 2 ;;
    --aio-public-port) AIO_PUBLIC_PORT="$2"; shift 2 ;;
    --aio-public-url) [[ $# -ge 2 ]] || die "--aio-public-url requires an HTTPS URL"; AIO_PUBLIC_URL="${2%/}"; shift 2 ;;
    --aio-user) AIO_USER="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -y|--yes) shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done
[[ $EUID -eq 0 ]] || die "Run as root: sudo $0 $*"
[[ "$HTTPS" == localip || "$HTTPS" == none ]] || die "--https must be 'localip' or 'none'"
[[ -z "$PUBLIC_PORT" || "$PUBLIC_PORT" =~ ^[0-9]+$ ]] || die "--public-port must be a number"
[[ "$AIO_PORT" =~ ^[0-9]+$ ]] || die "--aio-port must be a number"
[[ -z "$AIO_PUBLIC_PORT" || "$AIO_PUBLIC_PORT" =~ ^[0-9]+$ ]] || die "--aio-public-port must be a number"
[[ -z "$AIO_PUBLIC_URL" || "$AIO_PUBLIC_URL" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]{1,5})?$ ]] || die "--aio-public-url must be an HTTPS origin without a path, query, or fragment"
[[ "$AIO_USER" =~ ^[A-Za-z0-9._-]+$ ]] || die "--aio-user may only contain letters, digits, . _ -"
[[ -z "$PUBLIC_URL_EXT" || "$PUBLIC_URL_EXT" =~ ^https:// ]] || die "--public-url must start with https:// (Stremio requires HTTPS)"
if [[ -n "$PUBLIC_IP" && "$HTTPS" == none ]]; then die "--public-ip needs the built-in HTTPS (don't combine it with --https none; use --public-url for your own HTTPS)"; fi

echo
echo "${c_b}  ███  ${NAME}${c_0}"
echo "${c_b}  ═══  AI Greek subtitles for Stremio${c_0}"
echo

# ---------------------------------------------------------------- uninstall
if [[ $UNINSTALL -eq 1 ]]; then
  step "Removing $NAME"
  systemctl disable --now "$APP" 2>/dev/null || true
  rm -f "/etc/systemd/system/$APP.service"
  systemctl daemon-reload
  rm -f "/etc/nginx/sites-enabled/$APP" "/etc/nginx/sites-available/$APP"
  if [[ -f "$AIO_DIR/compose.yaml" ]] && command -v docker >/dev/null; then
    (cd "$AIO_DIR" && docker compose down) >/dev/null 2>&1 || true
    rm -f /etc/nginx/sites-enabled/aiostreams /etc/nginx/sites-available/aiostreams /etc/cron.weekly/aiostreams-update /usr/local/bin/aiostreams-update
    ok "Stopped AIOStreams"
  fi
  command -v nginx >/dev/null && nginx -t -q 2>/dev/null && systemctl reload nginx || true
  if [[ $PURGE -eq 1 ]]; then rm -rf "$DIR" "$CONF" "$ENVFILE" "$AIO_DIR"; userdel "$SVC_USER" 2>/dev/null || true; ok "Removed program and data"
  else find "$DIR" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} + 2>/dev/null || true; ok "Removed program (settings kept in $DIR/data; use --purge to delete)"; fi
  exit 0
fi

[[ -f "$SRC/server.js" && -f "$SRC/package.json" ]] || die "Run this script from the unpacked $NAME folder"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$SRC/package.json" | head -1)

# ---------------------------------------------------------------- Node.js
need_node() { command -v node >/dev/null || return 0; local v; v=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0); [[ $v -lt 18 ]]; }
if need_node; then
  step "Installing Node.js 22"
  command -v apt-get >/dev/null || die "Node.js 18+ is required. Install it, then re-run this script."
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
NODE=$(command -v node)
ok "Node.js $($NODE -v) at $NODE"

# ---------------------------------------------------------------- user + files
id "$SVC_USER" &>/dev/null || useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin "$SVC_USER"
step "Installing $NAME v$VERSION to $DIR"
mkdir -p "$DIR/data"
for item in server.js package.json src public README.md INSTALL.md LICENSE install.sh; do
  [[ -e "$SRC/$item" ]] || continue
  rm -rf "${DIR:?}/$item"
  cp -r "$SRC/$item" "$DIR/"
done

# Carry over settings from an older installation so existing Stremio addon links keep working.
if [[ ! -f "$DIR/data/secret.key" ]]; then
  for old in "${OLD_DIRS[@]}"; do
    if [[ -f "$old/data/secret.key" ]]; then
      step "Migrating settings, cache and sign-ins from $old"
      cp -a "$old/data/." "$DIR/data/"
      ok "Migrated (old folder left in place; delete it when you're happy)"
      break
    fi
  done
fi
chown -R "$SVC_USER:$SVC_USER" "$DIR"
chmod 700 "$DIR/data"

# Stop old services that would clash on the port or hostname.
for s in "${OLD_SERVICES[@]}"; do
  if systemctl list-unit-files "$s.service" &>/dev/null && systemctl cat "$s" &>/dev/null; then
    step "Disabling old service $s"; systemctl disable --now "$s" 2>/dev/null || true
    rm -f "/etc/systemd/system/$s.service"; systemctl daemon-reload
  fi
done

# Port check: another program (not us) already listening?
if ss -ltnH "sport = :$PORT" 2>/dev/null | grep -q . && ! systemctl is-active --quiet "$APP"; then
  for p in $(seq $((PORT+1)) $((PORT+50))); do ss -ltnH "sport = :$p" | grep -q . || { warn "Port $PORT is busy; using $p"; PORT=$p; break; }; done
fi

# ---------------------------------------------------------------- HTTPS (local-ip.sh)
PUBLIC_URL=""
LAN_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)
[[ -n "$LAN_IP" ]] || LAN_IP=$(hostname -I | awk '{print $1}')
# ---------------------------------------------------------------- outside access (public IP / URL)
EXTERNAL_URL=""; EXT_HOST=""
if [[ -n "$PUBLIC_IP" ]]; then
  if [[ "$PUBLIC_IP" == auto ]]; then
    DETECTED=$(curl -fsS -m 8 https://api.ipify.org 2>/dev/null || curl -fsS -m 8 https://ifconfig.me/ip 2>/dev/null || true)
    [[ "$DETECTED" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Could not detect your public IP; give it with --public-ip 1.2.3.4"
    ok "Public IP detected: $DETECTED (re-run the installer if it changes)"
    PUB_ADDR=$DETECTED
  else
    [[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--public-ip must be an IPv4 address or 'auto'"
    PUB_ADDR=$PUBLIC_IP
  fi
  EXT_HOST="${PUB_ADDR//./-}.local-ip.sh"
elif [[ -n "$PUBLIC_URL_EXT" ]]; then
  EXTERNAL_URL="$PUBLIC_URL_EXT"
  EXT_HOST=$(echo "$PUBLIC_URL_EXT" | sed -E 's#^https://([^/:]+).*#\1#')
fi
NEW_PASSWORD=0
if [[ -n "$EXT_HOST" && -z "$CONFIG_PASSWORD" ]]; then
  CONFIG_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-16)
  NEW_PASSWORD=1
fi

if [[ "$HTTPS" == localip ]]; then
  HOSTN="${LAN_IP//./-}.local-ip.sh"
  step "Setting up HTTPS at https://$HOSTN (works on your home network)"
  if ! command -v nginx >/dev/null; then
    command -v apt-get >/dev/null || die "nginx is needed for HTTPS. Install it or use --https none."
    apt-get install -y -qq nginx >/dev/null
  fi
  HTTPS_PORT=443
  if ss -ltnpH "sport = :443" 2>/dev/null | grep -q . && ! ss -ltnpH "sport = :443" | grep -q nginx; then
    HTTPS_PORT=8443; warn "Port 443 is used by another program; using 8443"
  fi
  mkdir -p /etc/ssl/local-ip
  cat > /usr/local/bin/refresh-local-ip-cert <<'EOF'
#!/bin/sh
# Refreshes the public wildcard certificate for *.local-ip.sh (LAN HTTPS for AIO-Streams&Subtitles-Greek).
set -e
curl -fsS -m 30 -o /tmp/lip.pem https://local-ip.sh/server.pem
curl -fsS -m 30 -o /tmp/lip.key https://local-ip.sh/server.key
openssl x509 -in /tmp/lip.pem -noout >/dev/null
install -m 644 /tmp/lip.pem /etc/ssl/local-ip/server.pem
install -m 600 /tmp/lip.key /etc/ssl/local-ip/server.key
rm -f /tmp/lip.pem /tmp/lip.key
nginx -t -q && systemctl reload nginx
EOF
  chmod 755 /usr/local/bin/refresh-local-ip-cert
  ln -sf /usr/local/bin/refresh-local-ip-cert /etc/cron.weekly/refresh-local-ip-cert
  curl -fsS -m 30 -o /etc/ssl/local-ip/server.pem https://local-ip.sh/server.pem || die "Could not download the local-ip.sh certificate (internet access needed), or use --https none"
  curl -fsS -m 30 -o /etc/ssl/local-ip/server.key https://local-ip.sh/server.key
  chmod 600 /etc/ssl/local-ip/server.key
  for s in "${OLD_SITES[@]}"; do rm -f "/etc/nginx/sites-enabled/$s" "/etc/nginx/sites-available/$s"; done
  cat > "/etc/nginx/sites-available/$APP" <<EOF
# $NAME — HTTPS for the Stremio addon
server {
    listen $HTTPS_PORT ssl;
    listen [::]:$HTTPS_PORT ssl;
    server_name $HOSTN${EXT_HOST:+ $EXT_HOST};
    ssl_certificate     /etc/ssl/local-ip/server.pem;
    ssl_certificate_key /etc/ssl/local-ip/server.key;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 120s;
    }
}
EOF
  ln -sf "/etc/nginx/sites-available/$APP" "/etc/nginx/sites-enabled/$APP"
  nginx -t -q || die "nginx configuration test failed"
  systemctl enable --now nginx >/dev/null 2>&1 || true
  systemctl reload nginx
  PUBLIC_URL="https://$HOSTN"; [[ $HTTPS_PORT -ne 443 ]] && PUBLIC_URL="$PUBLIC_URL:$HTTPS_PORT"
  if [[ -n "$PUBLIC_IP" ]]; then
    PUBLIC_PORT=${PUBLIC_PORT:-$HTTPS_PORT}
    EXTERNAL_URL="https://$EXT_HOST"; [[ $PUBLIC_PORT -ne 443 ]] && EXTERNAL_URL="$EXTERNAL_URL:$PUBLIC_PORT"
  fi
  ok "HTTPS ready (certificate refreshes weekly)"
fi

# ---------------------------------------------------------------- service
# ---------------------------------------------------------------- AIOStreams address
AIO_URL=""
if [[ $AIOSTREAMS -eq 1 ]]; then
  case "$(uname -m)" in
    x86_64|amd64|aarch64|arm64) ;;
    *) warn "AIOStreams needs a 64-bit system (amd64/arm64); skipping it on $(uname -m). Use a 64-bit OS image to include it."; AIOSTREAMS=0 ;;
  esac
fi
if [[ $AIOSTREAMS -eq 1 ]]; then
  if [[ "$HTTPS" == localip ]]; then
    AIO_HOME_URL="https://$HOSTN:$AIO_PORT"
    if [[ -n "$PUBLIC_IP" ]]; then AIO_PUBLIC_PORT=${AIO_PUBLIC_PORT:-$AIO_PORT}; AIO_URL="https://$EXT_HOST:$AIO_PUBLIC_PORT"
    else AIO_URL="$AIO_HOME_URL"; fi
  else
    AIO_HOME_URL="http://$LAN_IP:3000"; AIO_URL="$AIO_HOME_URL"
  fi
  if [[ -n "$AIO_PUBLIC_URL" ]]; then AIO_URL="$AIO_PUBLIC_URL"; fi
fi

# Save these before the environment file is overwritten, including during name migration.
LOCAL_LLM_URL=""
PRIORITY_SUBTITLE_SOURCES=""
if [[ -r "$ENV_SRC" ]]; then
  LOCAL_LLM_URL=$(sed -n 's/^LOCAL_LLM_URL=//p' "$ENV_SRC" | tail -1)
  PRIORITY_SUBTITLE_SOURCES=$(sed -n 's/^PRIORITY_SUBTITLE_SOURCES=//p' "$ENV_SRC" | tail -1)
fi

# Remember the choices for the next update; keep secrets out of the world-readable unit file.
umask 077
{
  echo "# $NAME installer settings (re-used by updates)"
  echo "PORT=$PORT"; echo "HTTPS=$HTTPS"
  echo "PUBLIC_IP=$PUBLIC_IP"; echo "PUBLIC_PORT=$PUBLIC_PORT"; echo "PUBLIC_URL_EXT=$PUBLIC_URL_EXT"
  echo "AIOSTREAMS=$AIOSTREAMS"; echo "AIO_PORT=$AIO_PORT"; echo "AIO_PUBLIC_PORT=$AIO_PUBLIC_PORT"; echo "AIO_PUBLIC_URL=$AIO_PUBLIC_URL"; echo "AIO_USER=$AIO_USER"
} > "$CONF"
{
  if [[ -n "$EXTERNAL_URL" ]]; then echo "EXTERNAL_URL=$EXTERNAL_URL"; fi
  if [[ -n "$CONFIG_PASSWORD" ]]; then echo "CONFIG_PASSWORD=$CONFIG_PASSWORD"; fi
  if [[ -n "$AIO_URL" ]]; then echo "AIOSTREAMS_URL=$AIO_URL"; fi
  if [[ -n "$LOCAL_LLM_URL" ]]; then printf 'LOCAL_LLM_URL=%s\n' "$LOCAL_LLM_URL"; fi
  if [[ -n "$PRIORITY_SUBTITLE_SOURCES" ]]; then printf 'PRIORITY_SUBTITLE_SOURCES=%s\n' "$PRIORITY_SUBTITLE_SOURCES"; fi
} > "$ENVFILE"
chmod 600 "$CONF" "$ENVFILE"
umask 022

step "Creating service $APP"
cat > "/etc/systemd/system/$APP.service" <<EOF
[Unit]
Description=$NAME (Stremio AI Greek subtitles)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
WorkingDirectory=$DIR
ExecStart=$NODE server.js
Environment=PORT=$PORT
Environment=DATA_DIR=$DIR/data
Environment=PUBLIC_URL=$PUBLIC_URL
EnvironmentFile=-$ENVFILE
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$DIR/data

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$APP" >/dev/null 2>&1
systemctl restart "$APP"

for _ in $(seq 1 20); do curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null || die "Service did not start. Check: journalctl -u $APP -e"
ok "Service running (v$VERSION, port $PORT)"

# ---------------------------------------------------------------- AIOStreams (bundled)
AIO_NEW_PW=""
if [[ $AIOSTREAMS -eq 1 ]]; then
  step "Setting up AIOStreams (streams aggregator) at $AIO_URL"
  if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    step "Installing Docker"
    curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 || die "Docker installation failed (see https://docs.docker.com/engine/install/), or use --no-aiostreams"
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi
  mkdir -p "$AIO_DIR/data"
  # Host port for the container: 3000 unless something else (not AIOStreams) uses it.
  AIO_INTERNAL=3000
  if ss -ltnH "sport = :$AIO_INTERNAL" | grep -q . && ! docker ps --format '{{.Names}}' | grep -qx aiostreams; then
    for p in $(seq 3001 3050); do ss -ltnH "sport = :$p" | grep -q . || { AIO_INTERNAL=$p; break; }; done
    warn "Port 3000 is busy; AIOStreams uses $AIO_INTERNAL internally"
  fi
  if [[ ! -f "$AIO_DIR/.env" ]]; then
    AIO_NEW_PW=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-16)
    umask 077
    {
      echo "# AIOStreams settings - https://aiostreams.org/configuration/environment-variables"
      echo "BASE_URL=$AIO_URL"
      echo "# Encrypts stored configurations. NEVER change it after the first run."
      echo "SECRET_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
      echo "DATABASE_URI=sqlite://./data/db.sqlite"
      echo "NODE_ENV=production"
      echo "# Login for this instance (username:password)."
      echo "AIOSTREAMS_AUTH=$AIO_USER:$AIO_NEW_PW"
      if [[ -n "$AIO_PUBLIC_URL" ]]; then echo "AIOSTREAMS_AUTH_REQUIRED=true"; fi
      printf '%s\n' 'TEMPLATE_URLS=["https://raw.githubusercontent.com/jfle/aio-streams-subtitles-greek/main/templates/aiostreams-tablet-greek.json","https://raw.githubusercontent.com/jfle/aio-streams-subtitles-greek/main/templates/aiostreams-english-greek.json"]'
      printf '%s\n' 'FEATURED_TEMPLATE_IDS=["jfle.english-greek-stremio"]'
    } > "$AIO_DIR/.env"
    umask 022
  else
    # Keep the secret key, login and everything else; only follow address changes.
    sed -i "s#^BASE_URL=.*#BASE_URL=$AIO_URL#" "$AIO_DIR/.env"
  fi
  chmod 600 "$AIO_DIR/.env"
  if [[ "$HTTPS" == localip || -n "$AIO_PUBLIC_URL" ]]; then AIO_BIND="127.0.0.1:$AIO_INTERNAL:3000"; else AIO_BIND="$AIO_INTERNAL:3000"; fi
  cat > "$AIO_DIR/compose.yaml" <<EOF
# AIOStreams - bundled with $NAME. Settings: .env (keep SECRET_KEY unchanged). Update: sudo aiostreams-update
services:
  aiostreams:
    image: ghcr.io/viren070/aiostreams:latest
    container_name: aiostreams
    restart: unless-stopped
    ports:
      - "$AIO_BIND"
    env_file:
      - .env
    volumes:
      - ./data:/app/data
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
EOF
  if [[ "$HTTPS" == localip ]]; then
    cat > /etc/nginx/sites-available/aiostreams <<EOF
# AIOStreams (bundled with $NAME) - HTTPS with the local-ip.sh wildcard certificate
server {
    listen $AIO_PORT ssl;
    listen [::]:$AIO_PORT ssl;
    server_name $HOSTN${EXT_HOST:+ $EXT_HOST};
    ssl_certificate     /etc/ssl/local-ip/server.pem;
    ssl_certificate_key /etc/ssl/local-ip/server.key;
    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:$AIO_INTERNAL;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Host \$http_host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_buffering off;
    }
}
EOF
    ln -sf /etc/nginx/sites-available/aiostreams /etc/nginx/sites-enabled/aiostreams
    nginx -t -q || die "nginx configuration test failed (AIOStreams site)"
    systemctl reload nginx
  fi
  cat > /usr/local/bin/aiostreams-update <<'EOF'
#!/bin/sh
# Updates AIOStreams to the latest release (settings and configurations are kept).
set -e
cd /opt/aiostreams
docker compose pull -q
docker compose up -d
docker image prune -f >/dev/null
EOF
  chmod 755 /usr/local/bin/aiostreams-update
  ln -sf /usr/local/bin/aiostreams-update /etc/cron.weekly/aiostreams-update
  (cd "$AIO_DIR" && docker compose pull -q && docker compose up -d) >/dev/null 2>&1 || die "Could not start AIOStreams (docker compose in $AIO_DIR)"
  for _ in $(seq 1 90); do curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$AIO_INTERNAL/" 2>/dev/null && break; sleep 2; done
  if curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$AIO_INTERNAL/" 2>/dev/null; then ok "AIOStreams running ($AIO_URL)"
  else warn "AIOStreams is still starting (first start downloads its databases). Check: docker logs -f aiostreams"; fi
elif [[ -f "$AIO_DIR/compose.yaml" ]] && command -v docker >/dev/null; then
  step "Stopping the bundled AIOStreams (--no-aiostreams; its data stays in $AIO_DIR)"
  (cd "$AIO_DIR" && docker compose down) >/dev/null 2>&1 || true
  rm -f /etc/nginx/sites-enabled/aiostreams /etc/cron.weekly/aiostreams-update
  command -v nginx >/dev/null && nginx -t -q 2>/dev/null && systemctl reload nginx || true
fi

URL="${PUBLIC_URL:-http://$LAN_IP:$PORT}"
echo
echo "${c_g}  Done!${c_0}  Next steps:"
echo "   1. Open  ${c_b}$URL/configure${c_0}  in a browser on your network"
echo "   2. Choose your AI provider (sign in or paste a key), click Test translation"
echo "   3. Click Generate install link → Install in Stremio"
[[ -z "$PUBLIC_URL" ]] && echo "   (HTTP only: paste the manifest URL into Stremio desktop's addon search box)"
if [[ -n "$EXTERNAL_URL" ]]; then
  echo
  echo "${c_g}  Outside your home network:${c_0} ${c_b}$EXTERNAL_URL${c_0}"
  if [[ -n "$PUBLIC_IP" ]]; then
    echo "   On your router, forward ${c_b}TCP port $PUBLIC_PORT${c_0} to ${c_b}$LAN_IP port $HTTPS_PORT${c_0} (\"port forwarding\" / \"virtual server\")."
    if curl -fsS -m 6 "$EXTERNAL_URL/health" >/dev/null 2>&1; then ok "Reachable through your public address (checked from this machine)"
    else warn "Not reachable through the public address from here yet - set up the port forward (some routers also need NAT loopback for this check)"; fi
  else
    echo "   Your domain/tunnel must provide HTTPS and forward to this machine (port $PORT)."
  fi
  echo "   In the configure page choose ${c_b}Anywhere${c_0} when generating the install link."
fi
if [[ $AIOSTREAMS -eq 1 ]]; then
  echo
  echo "${c_g}  AIOStreams:${c_0} ${c_b}$AIO_URL${c_0}"
  if [[ -n "$AIO_PUBLIC_URL" ]]; then
    echo "   Point your HTTPS tunnel or proxy at http://127.0.0.1:$AIO_INTERNAL."
  elif [[ "$AIO_URL" != "${AIO_HOME_URL:-}" ]]; then
    echo "   At home also: $AIO_HOME_URL   (router: forward TCP $AIO_PUBLIC_PORT to $LAN_IP port $AIO_PORT)"
  fi
  if [[ -n "$AIO_NEW_PW" ]]; then echo "${c_y}   Login (new): ${c_b}$AIO_USER / $AIO_NEW_PW${c_0}  - change it in $AIO_DIR/.env (AIOSTREAMS_AUTH), then: sudo aiostreams-update"
  else echo "   Login: as before (see AIOSTREAMS_AUTH in $AIO_DIR/.env)"; fi
  echo "   Add your debrid service there, and add the subtitle install link as a custom addon,"
  echo "   so Stremio needs only the AIOStreams addon. Updates: weekly, or sudo aiostreams-update"
fi
if [[ -n "$CONFIG_PASSWORD" ]]; then
  echo
  if [[ $NEW_PASSWORD -eq 1 ]]; then echo "${c_y}  Configuration-page password (new): ${c_b}$CONFIG_PASSWORD${c_0}  - keep it; change with --password"
  else echo "   The configuration page is password protected (change with --password)"; fi
fi
echo
echo "   Logs:    journalctl -u $APP -f"
echo "   Update:  run the newer installer the same way (settings are kept)"
echo "   Remove:  sudo $DIR/install.sh --uninstall   (add --purge to delete all data, AIOStreams included)"
echo
