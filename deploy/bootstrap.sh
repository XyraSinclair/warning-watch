#!/bin/bash
# Warning Watch — fresh-box bootstrap (Ubuntu 24.04, run as root).
#
#   curl -fsSL https://raw.githubusercontent.com/XyraSinclair/warning-watch/main/deploy/bootstrap.sh | bash
#   # or: bash deploy/bootstrap.sh   (from a checkout)
#
# Idempotent: safe to rerun until the system is green. Two secrets gate the
# last mile and are printed as TODOs if absent:
#   /etc/warning-watch.env   — service secrets (restore from vault/backup,
#                               or fill the generated template)
#   /etc/cloudflared/token    — tunnel token (export CLOUDFLARED_TUNNEL_TOKEN
#                               before running, or place the file yourself)
# Historical data restores from data/backups/<day>/ if you have one; without
# it the system starts collecting immediately and the repair timer backfills
# recent history from the ADSBx archive on its own.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/XyraSinclair/warning-watch.git}"
# Fixed canonical layout: the systemd units in config/systemd/ hardcode
# this user and path, so they are not knobs here.
TARGET=/opt/dev/warning-watch
RUN_USER=xyra
ENV_FILE=/etc/warning-watch.env

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

echo "--- packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -qy git curl ca-certificates sqlite3 python3 python3-venv \
  build-essential ufw rsync

if ! command -v node >/dev/null || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 22 ]; then
  echo "--- node 24 (nodesource)"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -qy nodejs
fi

if ! command -v cloudflared >/dev/null; then
  echo "--- cloudflared"
  curl -fsSL -o /tmp/cloudflared.deb \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  dpkg -i /tmp/cloudflared.deb
fi

if ! command -v ntfy >/dev/null; then
  echo "--- ntfy"
  NTFY_VERSION=2.27.0
  curl -fsSL -o /tmp/ntfy.deb \
    "https://github.com/binwiederhier/ntfy/releases/download/v${NTFY_VERSION}/ntfy_${NTFY_VERSION}_linux_amd64.deb"
  dpkg -i /tmp/ntfy.deb
fi

echo "--- user + checkout"
id "$RUN_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$RUN_USER"
mkdir -p "$(dirname "$TARGET")"
if [ -d "$TARGET/.git" ]; then
  sudo -u "$RUN_USER" git -C "$TARGET" pull --ff-only
else
  git clone "$REPO_URL" "$TARGET"
  chown -R "$RUN_USER:$RUN_USER" "$TARGET"
fi

echo "--- node + python deps"
sudo -u "$RUN_USER" bash -c "cd '$TARGET' && npm ci"
sudo -u "$RUN_USER" bash -c "cd '$TARGET' && python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt"

echo "--- ntfy config (canonical source: config/ntfy-server.yml)"
mkdir -p /etc/ntfy /var/lib/ntfy
install -m 644 "$TARGET"/config/ntfy-server.yml /etc/ntfy/server.yml
if [ ! -f /var/lib/ntfy/user.db ]; then
  echo "TODO: restore /var/lib/ntfy/user.db from backup, or create the publisher:"
  echo "  ntfy user add --role=user ews && ntfy access ews 'warning-watch-*' write-only"
  echo "  ntfy token add ews   # -> EWS_NTFY_TOKEN in $ENV_FILE"
fi

echo "--- env file"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'ENV_EOF'
NODE_ENV=production
HOST=127.0.0.1
PORT=3030
EWS_PUBLIC_URL=https://warning.watch
NOTIFICATION_HASH_SECRET=FILL_ME
NOTIFICATION_ENCRYPTION_KEY=FILL_ME
LEVEL5_NOTIFICATION_CONCURRENCY=4
LEVEL5_SMS_MIN_INTERVAL_MS=250
INTERNAL_ALERT_TOKEN=FILL_ME
WEB_PUSH_VAPID_PUBLIC_KEY=FILL_ME
WEB_PUSH_VAPID_PRIVATE_KEY=FILL_ME
WEB_PUSH_CONTACT=mailto:xyra@exopriors.com
EWS_NTFY_TOPIC=warning-watch-alerts
EWS_NTFY_SERVER=http://127.0.0.1:2586
EWS_NTFY_OPS_TOPIC=warning-watch-ops
EWS_NTFY_TOKEN=FILL_ME
EWS_NTFY_PUBLIC_SERVER=https://ntfy.warning.watch
ENV_EOF
  chmod 600 "$ENV_FILE"
  echo "TODO: $ENV_FILE written with FILL_ME placeholders — restore real values"
  echo "      from vault/backup, then rerun this script."
fi

echo "--- cloudflared token"
mkdir -p /etc/cloudflared
if [ ! -f /etc/cloudflared/token ]; then
  if [ -n "${CLOUDFLARED_TUNNEL_TOKEN:-}" ]; then
    printf '%s' "$CLOUDFLARED_TUNNEL_TOKEN" > /etc/cloudflared/token
    chmod 600 /etc/cloudflared/token
  else
    echo "TODO: place the tunnel token at /etc/cloudflared/token (or export"
    echo "      CLOUDFLARED_TUNNEL_TOKEN and rerun). Tunnel + DNS live in the"
    echo "      Cloudflare account (remotely managed tunnel)."
  fi
fi

echo "--- systemd units (canonical source: config/systemd/)"
install -m 644 "$TARGET"/config/systemd/*.service "$TARGET"/config/systemd/*.timer \
  /etc/systemd/system/
systemctl daemon-reload

echo "--- firewall (ssh only; site is served through the tunnel)"
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null

echo "--- start"
if grep -q FILL_ME "$ENV_FILE"; then
  echo "HOLD: $ENV_FILE still has FILL_ME placeholders — services not started."
  echo "      Fill it, then rerun this script."
  exit 2
fi
systemctl enable --now ntfy
[ -f /etc/cloudflared/token ] && systemctl enable --now cloudflared \
  || echo "HOLD: cloudflared not started (no token yet)"
systemctl enable --now warning-watch.service
for timer in refresh refresh-imports repair backup watchdog canary sources cbrn selftest; do
  systemctl enable --now "warning-watch-$timer.timer"
done

echo "--- verify"
sleep 2
curl -fsS http://127.0.0.1:3030/api/health && echo && echo "OK: backend healthy"
echo "Optional: restore historical DBs from a backup day into $TARGET/data/"
echo "  (stop timers first: systemctl stop 'warning-watch-*.timer'), or let"
echo "  the repair timer rebuild recent history from the ADSBx archive."
