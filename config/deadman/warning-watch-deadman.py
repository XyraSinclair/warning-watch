#!/usr/bin/env python3
"""Off-box dead-man for warning.watch.

The box's own watchdog cannot report the box being gone. This runs on another
machine every two minutes, fetches the public status, and pages a public
ntfy.sh topic when the site stops answering or its aircraft sampling stalls.

Dead means one of: two consecutive fetch failures (a single failure is the
network), the payload unparseable, or the newest aircraft sample older than
STALE_MINUTES (the refresh timer runs every two minutes). It pages on the
transition, again every REPAGE_HOURS while dead, and sends one recovery note.

Environment: DEADMAN_NTFY_URL (required, the full topic URL; keep the topic
name out of any public repo), DEADMAN_STATUS_URL, DEADMAN_STATE (state file).
"""
import calendar
import json
import os
import sys
import time
import urllib.request

STATUS_URL = os.environ.get("DEADMAN_STATUS_URL", "https://warning.watch/api/status")
NTFY_URL = os.environ.get("DEADMAN_NTFY_URL", "").strip()
STATE_PATH = os.environ.get("DEADMAN_STATE", os.path.expanduser("~/.local/state/warning-watch-deadman.json"))
STALE_MINUTES = 8
FAILURES_TO_PAGE = 2
REPAGE_HOURS = 6


def probe():
    """Return None when alive, else the reason it is dead."""
    try:
        request = urllib.request.Request(STATUS_URL, headers={"User-Agent": "warning-watch-deadman/1 (off-box liveness probe)"})
        with urllib.request.urlopen(request, timeout=25) as response:
            body = response.read()
            if response.status != 200:
                return f"HTTP {response.status}"
    except Exception as error:  # noqa: BLE001 - any failure is the same fact
        return f"fetch failed: {type(error).__name__}: {error}"[:200]
    try:
        payload = json.loads(body)
        newest = payload["aircraft"]["newestSample"]
        age_minutes = (time.time() - calendar.timegm(time.strptime(newest[:19], "%Y-%m-%dT%H:%M:%S"))) / 60
    except Exception as error:  # noqa: BLE001
        return f"status unreadable: {type(error).__name__}: {error}"[:200]
    if age_minutes > STALE_MINUTES:
        return f"aircraft sampling stalled: newest sample {age_minutes:.0f} min old"
    return None


def page(title, body, priority, tags):
    request = urllib.request.Request(
        NTFY_URL,
        data=body.encode(),
        headers={"Title": title, "Priority": priority, "Tags": tags},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=25) as response:
        if response.status != 200:
            raise RuntimeError(f"ntfy publish failed: HTTP {response.status}")


def main():
    if not NTFY_URL:
        print("DEADMAN_NTFY_URL is not set", file=sys.stderr)
        return 2
    try:
        with open(STATE_PATH) as handle:
            state = json.load(handle)
    except (OSError, ValueError):
        state = {}
    now = time.time()
    reason = probe()
    failures = state.get("failures", 0) + 1 if reason else 0
    down_since = state.get("downSince")
    paged_at = state.get("pagedAt")

    if reason and failures >= FAILURES_TO_PAGE:
        down_since = down_since or now
        age_min = (now - down_since) / 60
        if paged_at is None or now - paged_at >= REPAGE_HOURS * 3600:
            page(
                f"warning.watch is DOWN ({age_min:.0f} min, seen from off-box)",
                f"{reason}\nThe box's own watchdog cannot report this. Check the Hetzner box, the tunnel and warning-watch.service.",
                "urgent",
                "rotating_light",
            )
            paged_at = now
    elif not reason:
        if paged_at is not None:
            outage_min = (now - down_since) / 60 if down_since else 0
            page("warning.watch is back", f"Answering again after about {outage_min:.0f} min.", "default", "white_check_mark")
        down_since = None
        paged_at = None

    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, "w") as handle:
        json.dump({"failures": failures, "downSince": down_since, "pagedAt": paged_at, "checkedAt": now, "reason": reason}, handle)
    print(json.dumps({"alive": reason is None, "reason": reason, "failures": failures, "paged": paged_at is not None}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
