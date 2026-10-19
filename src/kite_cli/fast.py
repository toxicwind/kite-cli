"""kite-fast: run kite-cli commands over the warm kite-daemon connection.

Every kite-cli command acquires its gateway through cli.connect(). This
entry point swaps that one function for a socket-backed gateway with the
same call_json interface, so all existing commands — status, threads,
history, send, feed, goals, ideas, raw — run unchanged at one-RPC cost
instead of paying the full connection ceremony per call.

If the daemon is not running it is started detached (log:
~/.config/kite-cli/daemon.log) and the first command waits for the
gateway connection to come up. Streaming commands (watch) need a live
subscription and are refused here; use plain `kite-cli watch`.
"""

import json
import os
import socket
import subprocess
import sys
import time

from .daemon import sock_path
from .gateway import GatewayError


class DaemonGateway:
    """Gateway-shaped client talking to kite-daemon over its socket."""

    def __init__(self, path=None):
        self._path = path or sock_path()
        info = self._roundtrip({"method": "__ping__"}, deadline_s=20)
        self.vm_id = info.get("vm_id")

    def _send(self, req, deadline_s):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(deadline_s + 10)
            s.connect(self._path)
            s.sendall((json.dumps(req) + "\n").encode())
            buf = b""
            while b"\n" not in buf:
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
        resp = json.loads(buf.split(b"\n", 1)[0])
        if resp.get("ok"):
            return resp.get("result")
        raise GatewayError(resp.get("status"),
                           resp.get("error", "daemon error"))

    def _roundtrip(self, req, deadline_s):
        try:
            return self._send(req, deadline_s)
        except (FileNotFoundError, ConnectionRefusedError):
            self._autostart()
            return self._send(req, deadline_s)

    def _autostart(self):
        from .cli import CONFIG_DIR

        log_path = os.path.join(CONFIG_DIR, "daemon.log")
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(log_path, "ab") as log:
            subprocess.Popen(
                [sys.executable, "-m", "kite_cli.daemon"],
                stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                start_new_session=True)
        # The daemon socket appears fast; the gateway behind it connects
        # on first real call. Wait only for the socket + ping.
        deadline = time.time() + 15
        while time.time() < deadline:
            if os.path.exists(self._path):
                try:
                    self._send({"method": "__ping__"}, deadline_s=5)
                    return
                except Exception:  # noqa: BLE001 - still coming up
                    pass
            time.sleep(0.2)

    def call_json(self, method, path_params=None, body=None, query=None,
                  timeout=30):
        return self._roundtrip(
            {"method": method, "path_params": path_params, "body": body,
             "query": query, "deadline_s": timeout},
            deadline_s=timeout)

    def subscribe_raw(self, *a, **kw):
        raise RuntimeError(
            "streaming is not served by kite-fast; use `kite-cli watch`")

    def subscribe_json(self, *a, **kw):
        raise RuntimeError(
            "streaming is not served by kite-fast; use `kite-cli watch`")

    def close(self):
        pass


def main():
    from . import cli

    cli.connect = lambda cfg=None: DaemonGateway()
    # The update check is per-invocation overhead the fast path exists
    # to skip; upgrades stay available via plain `kite-cli update`.
    cli.start_update_check = lambda: None
    cli.finish_update_check = lambda notice=None: None
    cli.main()


if __name__ == "__main__":
    main()
