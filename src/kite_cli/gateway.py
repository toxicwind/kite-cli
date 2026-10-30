"""Muse gateway client: HTTPS auth + WebSocket/Noise-XX transport + protobuf envelopes.

Derived from the muse.ai web app's own protocol (route table + framing observed
in its client bundle). Talks to the user's personal VM gateway directly.
No browser needed after the initial cookie export.
"""

import json
import os
import random
import struct
import sys
import threading
import time
import urllib.parse
import uuid
import queue as queue_mod

from curl_cffi import requests as rq
from curl_cffi.requests import WebSocket
from noise.connection import NoiseConnection, Keypair
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

_HERE = os.path.dirname(os.path.abspath(__file__))
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
)
GATEWAY_HOST = "hatch.metaaivm.com"

_pool = descriptor_pool.DescriptorPool()
for _i in (0, 1):
    _fd = descriptor_pb2.FileDescriptorProto()
    with open(os.path.join(_HERE, f"desc{_i}.bin"), "rb") as fh:
        _fd.ParseFromString(fh.read())
    _pool.Add(_fd)


def _msg(name):
    return message_factory.GetMessageClass(_pool.FindMessageTypeByName(name))


NoiseTransportFrame = _msg("ingress_rev_proxy.NoiseTransportFrame")
ServiceRequest = _msg("hatch.noise.ServiceRequest")
ServiceResponse = _msg("hatch.noise.ServiceResponse")
ServiceFrame = _msg("hatch.noise.ServiceFrame")
ApplicationRequest = _msg("hatch.noise.ApplicationRequest")

with open(os.path.join(_HERE, "routes.json")) as fh:
    ROUTES = {e["method"]: e for e in json.load(fh)}

SERVICE_IDS = {"daemon": 0, "sentinel": 1, "vault": 2, "authd": 3}


class AuthError(RuntimeError):
    pass


class GatewayError(RuntimeError):
    def __init__(self, status, payload):
        super().__init__(f"gateway status={status} payload={payload!r}")
        self.status = status
        self.payload = payload


def _hatch_headers(cookies, access_token=None):
    h = {
        "User-Agent": UA,
        "Referer": "https://muse.ai/",
        "Origin": "https://muse.ai",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Cookie": cookies,
    }
    if access_token:
        h["Authorization"] = f"Bearer {access_token}"
    return h


def fetch_access_token(cookies, base_url="https://muse.ai"):
    r = rq.post(
        f"{base_url}/api/auth/check",
        headers=_hatch_headers(cookies),
        data=b"",
        impersonate="chrome",
        timeout=20,
    )
    if r.status_code != 200:
        raise AuthError(
            f"auth/check -> {r.status_code} {r.text[:120]} (cookies expired? re-export)"
        )
    return r.json()["access_token"]


def fetch_hatch_token(cookies, access_token, vm_id, base_url="https://muse.ai"):
    r = rq.post(
        f"{base_url}/api/hatch/token",
        headers=_hatch_headers(cookies, access_token),
        json={"vmAddress": f"wss://{vm_id}.metaaivm.com/", "vmName": vm_id},
        impersonate="chrome",
        timeout=20,
    )
    if r.status_code != 200:
        raise AuthError(f"hatch/token -> {r.status_code} {r.text[:160]}")
    return r.json()["token"]


def load_cookies(path):
    """Accept a curl-style 'a=b; c=d' file or {"cookies": {...}} JSON."""
    raw = open(path).read().strip()
    if raw.startswith("{"):
        try:
            d = json.loads(raw)
            if (
                isinstance(d, dict)
                and "cookies" in d
                and isinstance(d["cookies"], dict)
            ):
                return "; ".join(f"{k}={v}" for k, v in d["cookies"].items())
            return "; ".join(f"{k}={v}" for k, v in d.items())
        except json.JSONDecodeError:
            pass
    if "hatch_sess=" in raw or "datr=" in raw:
        for line in raw.splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line and ";" in line:
                return line
        return " ".join(raw.split())
    # Netscape cookie-jar format
    parts = []
    for line in raw.splitlines():
        if not line or line.startswith("#"):
            continue
        cols = line.split("\t")
        if len(cols) >= 7:
            parts.append(f"{cols[5]}={cols[6]}")
    if not parts:
        raise AuthError(f"could not parse cookies file {path}")
    return "; ".join(parts)


def fetch_session_info(cookies, base_url="https://muse.ai"):
    """Discover the user's assigned personal VM (id + gateway URL)."""
    r = rq.get(
        f"{base_url}/api/session",
        headers=_hatch_headers(cookies),
        impersonate="chrome",
        timeout=20,
    )
    if r.status_code != 200:
        raise AuthError(f"api/session -> {r.status_code} (cookies expired? re-export)")
    try:
        info = r.json()
    except ValueError:
        raise AuthError(f"api/session returned non-JSON ({r.text[:80]!r})")
    if "vm_id" not in info:
        # The VM is down/restarting: {"status":"unavailable",
        # "vm_resolution_issue":{"kind":"retryable"}}. Not an auth problem,
        # so say so: retry, or wake a known VM id directly.
        raise GatewayError(
            -1,
            f"VM unavailable ({info!r}); retry shortly or "
            "`MUSE_VM_ID=<id> kite-cli wake`",
        )
    return info


def wake_vm(cookies, vm_id, access_token=None, base_url="https://muse.ai"):
    """Wake a known VM id via Meta's hatch VM API."""
    h = _hatch_headers(cookies, access_token)
    r = rq.post(
        f"{base_url}/api/hatch/vm/wake",
        headers=h,
        json={"vmAddress": f"wss://{vm_id}.metaaivm.com/", "vmName": vm_id},
        impersonate="chrome",
        timeout=20,
    )
    if r.status_code != 200:
        raise GatewayError(r.status_code, r.text[:160])


class Gateway:
    """One authenticated connection to the personal VM gateway."""

    def __init__(self, cookies, vm_id=None, access_token=None, hatch_token=None):
        if vm_id is None:
            vm_id = fetch_session_info(cookies)["vm_id"]
        self.vm_id = vm_id
        access_token = access_token or fetch_access_token(cookies)
        hatch_token = hatch_token or fetch_hatch_token(cookies, access_token, vm_id)
        url = (
            f"wss://{GATEWAY_HOST}/v1/noise?vm_id={vm_id}"
            f"&auth_token={urllib.parse.quote(hatch_token, safe='')}"
        )
        self.ws = WebSocket()
        # verify=True is required: curl_cffi's WebSocket.connect defaults to
        # verify=None, which disables TLS certificate verification entirely.
        self.ws.connect(url, impersonate="chrome", timeout=20, verify=True)
        noise = NoiseConnection.from_name(b"Noise_XX_25519_AESGCM_SHA256")
        noise.set_as_initiator()
        noise.set_keypair_from_private_bytes(Keypair.STATIC, os.urandom(32))
        noise.start_handshake()
        self.ws.send_bytes(bytes(noise.write_message(b"")))
        m2, _ = self.ws.recv()
        noise.read_message(bytes(m2))
        self.ws.send_bytes(bytes(noise.write_message(b"")))
        assert noise.handshake_finished
        self.noise = noise
        self.stream = 1
        self._send_lock = threading.Lock()
        self._recv_lock = threading.Lock()
        # --- keep-alive + auto-reconnect (borrowed from tulir/whatsmeow) ---
        # whatsmeow keepAliveLoop: randomized 20-30s app pings, 10s response
        # deadline, 3min of failures forces a reconnect. Prevents the tailscale
        # DERP ~2m15s idle-close from killing the bridge. Disable with the
        # KITE_CLI_NO_KEEPALIVE=1 env var (dev/hot-reload toggle).
        self._ka_stop = threading.Event()
        self._ka_enabled = not os.environ.get("KITE_CLI_NO_KEEPALIVE")
        self._ka_interval_ms = int(os.environ.get("KITE_CLI_KEEPALIVE_MS", "25000"))
        self._ka_deadline_s = float(os.environ.get("KITE_CLI_KEEPALIVE_DEADLINE", "10"))
        self._ka_max_fail_s = float(os.environ.get("KITE_CLI_KEEPALIVE_MAXFAIL", "180"))
        self._ka_reconnect = os.environ.get("KITE_CLI_AUTO_RECONNECT", "1") != "0"
        if self._ka_enabled:
            t = threading.Thread(target=self._keepalive_loop, daemon=True)
            t.start()

    def _keepalive_loop(self):
        """App-layer keepalive: randomized sub-idle-interval ping. If repeated
        response deadlines pass without success, force a reconnect."""
        last_success = time.time()
        fails = 0
        while not self._ka_stop.wait(0):
            if self._ka_stop.is_set():
                return
            time.sleep(random.uniform(0.75, 1.25) * self._ka_interval_ms / 1000.0)
            ok = self._keepalive_ping()
            if ok:
                fails = 0
                last_success = time.time()
            else:
                fails += 1
                if (
                    self._ka_reconnect
                    and time.time() - last_success > self._ka_max_fail_s
                ):
                    # force a reconnect: close and re-open the transport
                    try:
                        self._reconnect()
                        fails = 0
                        last_success = time.time()
                    except Exception as exc:  # noqa: BLE001
                        sys.stderr.write(
                            f"[gateway] keepalive reconnect failed: {exc}\n"
                        )

    def _keepalive_ping(self):
        """Send a lightweight request as a keepalive; true on success/deadline-ok."""
        try:
            return self.request("config.get", timeout=int(self._ka_deadline_s))
        except Exception:  # noqa: BLE001
            return False

    def _reconnect(self):
        # Re-establish the noise-XX websocket (same vm, fresh ephemeral key).
        old = self.ws
        try:
            old_was = None
            try:
                old.close()
            except Exception:  # noqa: BLE001
                pass
            self.ws = WebSocket()
            url = (
                f"wss://{GATEWAY_HOST}/v1/noise?vm_id={self.vm_id}"
                f"&auth_token={urllib.parse.quote(getattr(self, '_hatch_token', ''), safe='')}"
            )
            self.ws.connect(url, impersonate="chrome", timeout=20, verify=True)
            noise = NoiseConnection.from_name(b"Noise_XX_25519_AESGCM_SHA256")
            noise.set_as_initiator()
            noise.set_keypair_from_private_bytes(Keypair.STATIC, os.urandom(32))
            noise.start_handshake()
            self.ws.send_bytes(bytes(noise.write_message(b"")))
            m2, _ = self.ws.recv()
            noise.read_message(bytes(m2))
            self.ws.send_bytes(bytes(noise.write_message(b"")))
            assert noise.handshake_finished
            self.noise = noise
        except Exception:
            # restore the old socket if re-establishment failed so callers
            # draining the old one don't get a broken ref
            self.ws = old
            raise

    # -- low-level framing -------------------------------------------------
    def _send_envelope(self, service_id, frame_bytes):
        outer = ServiceRequest(service=service_id, payload=frame_bytes)
        chunk_id = struct.unpack("<q", os.urandom(8))[0]
        fr = NoiseTransportFrame(
            chunk_id=chunk_id,
            chunk_index=0,
            total_chunks=1,
            payload=outer.SerializeToString(),
        )
        with self._send_lock:
            self.ws.send_bytes(bytes(self.noise.encrypt(fr.SerializeToString())))

    def _read_frame(self):
        # Serialized so two threads can never interleave ws.recv / Noise
        # decrypt (which corrupts the transport state -> BAD_DECRYPT).
        # Callers must still avoid *logical* races: only one thread should
        # be consuming frames at a time, or responses get misrouted.
        with self._recv_lock:
            data, _flags = self.ws.recv()
            pt = bytes(self.noise.decrypt(bytes(data)))
        ntf = NoiseTransportFrame()
        ntf.ParseFromString(pt)
        sr = ServiceResponse()
        sr.ParseFromString(ntf.payload)
        sf = ServiceFrame()
        sf.ParseFromString(sr.payload)
        return sf

    def _open(self, method, path_params=None, body=None, query=None):
        route = ROUTES[method]
        path = route["path"]
        for k, v in (path_params or {}).items():
            path = path.replace("{" + k + "}", urllib.parse.quote(str(v), safe=""))
        if query:
            qs = urllib.parse.urlencode(
                {k: v for k, v in query.items() if v is not None}
            )
            if qs:
                path = path + ("&" if "?" in path else "?") + qs
        raw = (
            b""
            if body is None
            else (body if isinstance(body, bytes) else json.dumps(body).encode())
        )
        req = ApplicationRequest(verb=route["http"], path=path, body=raw, end_body=True)
        h = req.headers.add()
        h.key = "x-request-id"
        h.value = str(uuid.uuid4())
        if raw:
            h2 = req.headers.add()
            h2.key = "content-type"
            h2.value = "application/json"
        frame = ServiceFrame(stream_id=self.stream)
        frame.request.CopyFrom(req)
        sid = self.stream
        self.stream += 1
        self._send_envelope(
            SERVICE_IDS.get(route.get("service", "daemon"), 0),
            frame.SerializeToString(),
        )
        return sid

    # -- unary request/response --------------------------------------------
    def request(self, method, path_params=None, body=None, query=None, timeout=30):
        route = ROUTES[method]
        if route["http"] == "GET" and body is not None and query is None:
            query, body = body, None
        sid = self._open(method, path_params, body, query)
        status, chunks, deadline = None, [], time.time() + timeout
        while time.time() < deadline:
            sf = self._read_frame()
            if sf.stream_id != sid:
                continue
            kind = sf.WhichOneof("kind")
            if kind == "response":
                status = sf.response.status
                if sf.response.body:
                    chunks.append(bytes(sf.response.body))
                if sf.response.end_body:
                    break
            elif kind == "body_chunk":
                chunks.append(bytes(sf.body_chunk.data))
                if sf.body_chunk.end_body:
                    break
            elif kind == "reset":
                raise GatewayError(
                    -1, f"stream reset {sf.reset.code}: {sf.reset.reason}"
                )
        if status is None:
            raise TimeoutError(f"no response for {method}")
        payload = b"".join(chunks)
        Gateway._raise_for_status(self, status, payload)
        return payload

    @staticmethod
    def _raise_for_status(_self, status, payload):
        """Raise a typed GatewayError for non-2xx gateway responses."""
        if status < 200 or status >= 300:
            raise GatewayError(status, payload[:500].decode("utf-8", "replace"))

    def call_json(self, method, path_params=None, body=None, query=None, timeout=30):
        raw = self.request(method, path_params, body, query, timeout)
        try:
            d = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            raise GatewayError(-1, f"non-JSON response: {raw[:200]!r}")
        if isinstance(d, dict) and d.get("ok") is False:
            raise GatewayError(-1, f"api error: {d.get('error')}")
        return d.get("result", d) if isinstance(d, dict) else d

    # -- subscriptions (ndjson event streams) -------------------------------
    def subscribe_raw(
        self,
        method,
        path_params=None,
        body=None,
        query=None,
        max_records=100,
        idle_timeout=10,
        overall_timeout=120,
    ):
        """Open a subscription; returns list of raw record bytes."""
        sid = self._open(method, path_params, body, query)
        buf, records = b"", []
        q: queue_mod.Queue = queue_mod.Queue()
        stop = False

        def reader():
            try:
                while not stop:
                    q.put(self._read_frame())
            except Exception as e:  # noqa: BLE001
                q.put(e)

        threading.Thread(target=reader, daemon=True).start()
        deadline = time.time() + overall_timeout
        idle = time.time() + idle_timeout
        try:
            while time.time() < deadline and len(records) < max_records:
                try:
                    sf = q.get(timeout=2)
                except queue_mod.Empty:
                    if time.time() > idle:
                        break
                    continue
                if isinstance(sf, Exception):
                    raise sf
                if sf.stream_id != sid:
                    continue
                idle = time.time() + idle_timeout
                kind = sf.WhichOneof("kind")
                if kind == "response":
                    if sf.response.body:
                        buf += bytes(sf.response.body)
                    if sf.response.end_body and not buf:
                        break
                elif kind == "body_chunk":
                    buf += bytes(sf.body_chunk.data)
                    if sf.body_chunk.end_body:
                        break
                elif kind == "reset":
                    break
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if line.strip():
                        records.append(line)
                        if len(records) >= max_records:
                            break
        finally:
            nonlocal_stop = True
            stop = nonlocal_stop
        if buf.strip():
            records.append(buf)
        return records

    def subscribe_json(self, *a, **kw):
        out = []
        for line in self.subscribe_raw(*a, **kw):
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out

    def close(self):
        try:
            self.ws.close()
        except Exception:  # noqa: BLE001
            pass
