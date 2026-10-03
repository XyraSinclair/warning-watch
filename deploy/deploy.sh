#!/bin/bash
# Deploy the checked-out main on xyra-dev-hetzner. Run as root after
# `sudo -H -u xyra git pull --ff-only` (OPERATIONS.md "Deploying a change").
#
# Every timer unit runs its pass under a shared lock on tmp/deploy.flock;
# this script takes it exclusively around `npm ci`, which empties
# node_modules before refilling it. Without the lock a pass starting in
# that window dies with "Could not locate the bindings file" (3 Oct 2026:
# four timers fired at 18:00:00 UTC into an install begun at 17:59:57).
# `npm ci` runs only when the installed tree no longer matches the lockfile.
set -euo pipefail
cd /opt/dev/warning-watch
as_xyra() { sudo -H -u xyra "$@"; }

sha=$(as_xyra git rev-parse --short HEAD)
echo "deploy: $sha"
as_xyra install -d tmp

lock_hash=$(sha256sum package-lock.json | cut -c1-64)
stamp=tmp/installed-package-lock.sha256
if [ -d node_modules ] && [ "$(cat "$stamp" 2>/dev/null)" = "$lock_hash" ]; then
  echo "install: node_modules already matches package-lock.json"
else
  echo "install: waiting for in-flight passes, then npm ci"
  as_xyra flock -x -w 600 tmp/deploy.flock npm ci --include=dev \
    || { echo "install: FAILED (lock wait or npm ci); nothing restarted" >&2; exit 1; }
  echo "$lock_hash" | as_xyra tee "$stamp" >/dev/null
fi

as_xyra npm run build --silent

drift=0
for f in config/systemd/*.service config/systemd/*.timer; do
  cmp -s "$f" "/etc/systemd/system/$(basename "$f")" || drift=1
done
if [ "$drift" = 1 ]; then
  install -m 644 config/systemd/*.service config/systemd/*.timer /etc/systemd/system/
  systemctl daemon-reload
  echo "units: installed from config/systemd and reloaded"
fi

systemctl restart warning-watch.service
as_xyra npm run status --silent | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const v = JSON.parse(s).verdict;
    console.log(`verify: healthy=${v.healthy} problems=${JSON.stringify(v.problems)}`);
  });'
