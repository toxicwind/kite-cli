#!/usr/bin/env python3
"""
test_daemon_maximal.py — TDD for the maximal kite-daemon surface.
LIVE probes only (no mocks): every test talks to the real socket, the real
gateway module, and the real cookies file.

Run:  python3 -m pytest src/kite_cli/test_daemon_maximal.py -v
      (or) python3 src/kite_cli/test_daemon_maximal.py
"""
import json
import os
import socket
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kite_cli import daemon  # noqa: E402
from kite_cli.daemon import GatewayHolder, sock_path  # noqa: E402

RESULTS = []


def check(name, fn):
    try:
        fn()
        RESULTS.append((name, "PASS", ""))
        print(f"  ✅ {name}")
    except AssertionError as e:
        RESULTS.append((name, "FAIL", str(e)))
        print(f"  ❌ {name}: {e}")
    except Exception as e:  # noqa: BLE001
        RESULTS.append((name, "ERROR", f"{type(e).__name__}: {e}"))
        print(f"  ⚠️ {name}: {type(e).__name__}: {e}")


def roundtrip(req, timeout=15):
    p = sock_path()
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(p)
    s.send((json.dumps(req) + "\n").encode())
    buf = b""
    while b"\n" not in buf:
        chunk = s.recv(65536)
        if not chunk:
            break
        buf += chunk
    s.close()
    return json.loads(buf.decode())


# ── 1. __ping__ contract preserved (back-compat) ────────────────────────────
def t_ping():
    r = roundtrip({"method": "__ping__"})
    assert r["ok"] is True, r
    assert "vm_id" in r["result"] and "uptime_s" in r["result"]


# ── 2. NEW __health__: lane + auth surfaces ─────────────────────────────────
def t_health():
    r = roundtrip({"method": "__health__"})
    assert r["ok"] is True, r
    h = r["result"]
    for key in ("daemon", "gateway", "auth"):
        assert key in h, f"missing {key}: {h}"
    assert h["daemon"]["sock"] == sock_path()
    assert isinstance(h["daemon"]["uptime_s"], (int, float))
    assert h["auth"]["cookies_path"]
    assert "cookies_age_s" in h["auth"] and "cookies_age_days" in h["auth"]
    assert h["auth"]["stale"] is (h["auth"]["cookies_age_days"] > 7)


# ── 3. NEW __auth_refresh__: refresh ladder returns a structured verdict ────
def t_auth_refresh():
    r = roundtrip({"method": "__auth_refresh__"}, timeout=60)
    assert r["ok"] is True, r
    v = r["result"]
    assert "refreshed" in v and "ladder" in v, v
    assert isinstance(v["ladder"], list) and v["ladder"], "ladder must be non-empty"
    for step in v["ladder"]:
        assert {"step", "ok", "detail"} <= set(step), step
    if v["refreshed"]:
        assert v.get("vm_id"), "refreshed lane must report vm_id"


# ── 4. 401-classified errors expose status=401 (refresh ladder trigger) ─────
def t_holder_builds_or_reports_auth():
    h = GatewayHolder()
    try:
        h._build()
        assert h.vm_id, "built gateway must have vm_id"
    except Exception as e:  # noqa: BLE001
        msg = f"{type(e).__name__}: {e}"
        assert "401" in msg or "Auth" in msg or "auth" in msg, msg


# ── 5. cookies freshness classifier (unit, live file) ───────────────────────
def t_cookie_age():
    from kite_cli.daemon import cookie_age_s

    age = cookie_age_s()
    assert age >= 0
    st = os.stat(sock_path())
    assert st.st_mtime > 0


if __name__ == "__main__":
    print(f"kite-daemon maximal TDD @ {time.strftime('%H:%M:%S')}")
    check("__ping__ back-compat", t_ping)
    check("__health__ surface", t_health)
    check("__auth_refresh__ ladder", t_auth_refresh)
    check("holder builds or 401-classifies", t_holder_builds_or_reports_auth)
    check("cookie age classifier", t_cookie_age)
    fails = [r for r in RESULTS if r[1] != "PASS"]
    print(f"\n{len(RESULTS)-len(fails)}/{len(RESULTS)} pass")
    sys.exit(1 if fails else 0)