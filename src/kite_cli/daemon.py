"""kite-daemon: hold one warm Gateway connection and serve kite-cli
commands over a local Unix socket.

A plain kite-cli call re-runs the whole connection ceremony every time:
auth token fetch, hatch token fetch, WebSocket+TLS connect, Noise_XX
handshake, then the RPC. That ceremony is the bulk of the 2-6s a single
`kite-cli status` costs. The daemon pays it once, keeps the connection
warm, and serves unary gateway calls to local clients (kite-fast) at
one-RPC cost.

Protocol: newline-delimited JSON on ~/.config/kite-cli/daemon.sock
  request : {"method": "chat.history", "path_params": {...},
             "body": {...}, "query": {...}, "deadline_s": 30}
  response: {"ok": true, "result": <json>}
          | {"ok": false, "error": "...", "status": <int|null>}
  meta    : {"method": "__ping__"} ->
            {"ok": true, "result": {"vm_id": ..., "uptime_s": ...}}

Gateway use is serialized: Gateway.request consumes frames on the
calling thread and concurrent consumers corrupt routing, so one lock
guards every call. A transport failure rebuilds the connection and the
request is retried exactly once; a real API error status is returned
to the client untouched.
"""

import json
import os
import socket
import socketserver
import sys
import threading
import time

from .gateway import GatewayError

DEFAULT_SOCK_NAME = "daemon.sock"


def sock_path():
    from .cli import CONFIG_DIR

    return os.path.join(CONFIG_DIR, DEFAULT_SOCK_NAME)


def _log(msg):
    print(f"[kite-daemon {time.strftime('%H:%M:%S')}] {msg}",
          file=sys.stderr, flush=True)


class GatewayHolder:
    """Owns the single warm Gateway; rebuilds it when the pipe breaks."""

    def __init__(self):
        self._gw = None
        self._lock = threading.Lock()
        self._built_at = None

    def _build(self):
        from .cli import connect, load_config

        if self._gw is not None:
            self._gw.close()
        self._gw = connect(load_config())
        self._built_at = time.time()
        _log(f"gateway connected (vm {self._gw.vm_id})")

    @property
    def vm_id(self):
        return self._gw.vm_id if self._gw is not None else None

    @property
    def uptime_s(self):
        return round(time.time() - self._built_at, 1) if self._built_at else 0

    def call(self, method, path_params=None, body=None, query=None,
             deadline_s=30):
        with self._lock:
            for attempt in (1, 2):
                try:
                    if self._gw is None:
                        self._build()
                    return self._gw.call_json(
                        method, path_params=path_params, body=body,
                        query=query, timeout=deadline_s)
                except GatewayError as e:
                    # A real API status is an answer, not a broken pipe.
                    if e.status is not None and e.status >= 100:
                        raise
                    _log(f"transport failure on {method} "
                         f"(attempt {attempt}): {e}")
                    self._gw = None
                    if attempt == 2:
                        raise
                except Exception as e:  # noqa: BLE001 - transport rebuild
                    _log(f"connection failure on {method} "
                         f"(attempt {attempt}): {type(e).__name__}: {e}")
                    self._gw = None
                    if attempt == 2:
                        raise


HOLDER = GatewayHolder()


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        line = self.rfile.readline()
        if not line:
            return
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            return self._reply({"ok": False, "error": f"bad json: {e}",
                                "status": None})
        method = req.get("method", "")
        if method == "__ping__":
            return self._reply({"ok": True, "result": {
                "vm_id": HOLDER.vm_id, "uptime_s": HOLDER.uptime_s}})
        try:
            result = HOLDER.call(
                method,
                path_params=req.get("path_params"),
                body=req.get("body"),
                query=req.get("query"),
                deadline_s=req.get("deadline_s", 30))
            self._reply({"ok": True, "result": result})
        except GatewayError as e:
            payload = e.payload
            if isinstance(payload, bytes):
                payload = payload[:500].decode("utf-8", "replace")
            self._reply({"ok": False,
                         "error": str(payload)[:500],
                         "status": e.status})
        except Exception as e:  # noqa: BLE001 - report, never crash the loop
            self._reply({"ok": False,
                         "error": f"{type(e).__name__}: {e}",
                         "status": None})

    def _reply(self, obj):
        self.wfile.write((json.dumps(obj) + "\n").encode())
        self.wfile.flush()


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    path = sock_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Clear a stale socket left by a dead daemon; a live one refuses.
    if os.path.exists(path):
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.connect(path)
            probe.close()
            _log(f"another daemon is already live on {path}")
            return 1
        except OSError:
            os.unlink(path)
    srv = Server(path, Handler)
    os.chmod(path, 0o600)
    _log(f"serving on {path}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.shutdown()
        if os.path.exists(path):
            os.unlink(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
