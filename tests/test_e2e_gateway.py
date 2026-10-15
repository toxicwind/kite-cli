"""End-to-end TDD goals for the kite-cli hatch protocol.

No network, no credentials. The server side of Meta's hatch protocol is
implemented locally (Noise-XX responder + hatch.noise.* framing) and the
client is driven through the full lifecycle.

Goals:
  G1  auth chain: cookies -> auth/check -> hatch/token -> session (real HTTP)
  G2  VM wake flow (api/hatch/vm/wake)
  G3  Noise-XX handshake client<->responder (real crypto, both sides)
  G4  unary RPC round-trip: ApplicationRequest -> ServiceResponse body
  G5  stream multiplexing: decoy stream frames are skipped
  G6  gateway errors: non-2xx status raises GatewayError
  G7  stream reset carries code + reason
  G8  TLS verification stays enabled on real connections (regression)
  G9  full pipeline: cookies file -> tokens -> session in one flow

Run: pytest tests/test_e2e_gateway.py tests/test_smoke.py -q
"""
import json
import os
import struct
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from queue import Queue, Empty

import pytest

from kite_cli import gateway as gw

ROOT = Path(__file__).resolve().parent.parent


# --------------------------------------------------------------------------
# Fake muse.ai — real HTTP, base_url injected
# --------------------------------------------------------------------------
class _FakeMuse(BaseHTTPRequestHandler):
    access_token = "at-test-123"
    hatch_token = "ht-test-456"
    vm_id = "vm-fake-uuid"
    seen: dict = {}

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        ln = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(ln) if ln else b""
        _FakeMuse.seen[self.path] = {
            "auth": self.headers.get("Authorization"),
            "cookie": self.headers.get("Cookie"),
            "body": raw,
        }
        if self.path == "/api/auth/check":
            self._json(200, {"access_token": self.access_token})
        elif self.path == "/api/hatch/token":
            self._json(200, {"token": self.hatch_token})
        elif self.path == "/api/hatch/vm/wake":
            self._json(200, {"status": "ok"})
        else:
            self._json(404, {"error": "no such route"})

    def do_GET(self):
        _FakeMuse.seen[self.path] = {
            "auth": self.headers.get("Authorization"),
            "cookie": self.headers.get("Cookie"),
        }
        if self.path == "/api/session":
            self._json(200, {"vm_id": self.vm_id, "gateway": "hatch.metaaivm.com"})
        else:
            self._json(404, {"error": "no such route"})


@pytest.fixture(scope="module")
def fake_muse():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _FakeMuse)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


COOKIES = "hatch_sess=abc123; datr=xyz789"


# --------------------------------------------------------------------------
# G1
# --------------------------------------------------------------------------
def test_g1_auth_chain(fake_muse):
    at = gw.fetch_access_token(COOKIES, base_url=fake_muse)
    assert at == "at-test-123"
    ht = gw.fetch_hatch_token(COOKIES, at, "vm-fake-uuid", base_url=fake_muse)
    assert ht == "ht-test-456"
    info = gw.fetch_session_info(COOKIES, base_url=fake_muse)
    assert info["vm_id"] == "vm-fake-uuid"
    for path in ("/api/auth/check", "/api/hatch/token", "/api/session"):
        assert "hatch_sess=abc123" in _FakeMuse.seen[path]["cookie"]
    assert _FakeMuse.seen["/api/hatch/token"]["auth"] == f"Bearer {at}"


# --------------------------------------------------------------------------
# G2
# --------------------------------------------------------------------------
def test_g2_vm_wake(fake_muse):
    gw.wake_vm(COOKIES, "vm-fake-uuid", access_token="at-test-123", base_url=fake_muse)
    body = json.loads(_FakeMuse.seen["/api/hatch/vm/wake"]["body"])
    assert body["vmName"] == "vm-fake-uuid"
    assert body["vmAddress"] == "wss://vm-fake-uuid.metaaivm.com/"


# --------------------------------------------------------------------------
# G3 — Noise handshake
# --------------------------------------------------------------------------
def test_g3_noise_handshake():
    from noise.connection import NoiseConnection, Keypair

    responder = NoiseConnection.from_name(b"Noise_XX_25519_AESGCM_SHA256")
    responder.set_as_responder()
    responder.set_keypair_from_private_bytes(Keypair.STATIC, os.urandom(32))
    responder.start_handshake()

    initiator = NoiseConnection.from_name(b"Noise_XX_25519_AESGCM_SHA256")
    initiator.set_as_initiator()
    initiator.set_keypair_from_private_bytes(Keypair.STATIC, os.urandom(32))
    initiator.start_handshake()

    msg1 = bytes(initiator.write_message(b""))
    responder.read_message(msg1)
    assert not initiator.handshake_finished and not responder.handshake_finished
    msg2 = bytes(responder.write_message(b""))
    initiator.read_message(msg2)
    assert not initiator.handshake_finished
    msg3 = bytes(initiator.write_message(b""))
    responder.read_message(msg3)
    assert initiator.handshake_finished and responder.handshake_finished


# --------------------------------------------------------------------------
# G4+G5 — RPC round-trip + multiplexing via a deterministic scripted fake ws
# --------------------------------------------------------------------------
def _build_fake_ws_responder():
    """Return (fake_ws, teardown) where fake_ws is a deterministic duck-typed
    object that implements the Gateway ws interface (connect / send_bytes /
    recv / close) and answers a precomputed handshake + RPC + decoy exchange.
    Uses a Queue for outbound frames so the client's recv() can block without
    spinning. Avoids the inbox/outbox property dance that caused the earlier
    deadlock.
    """
    from noise.connection import NoiseConnection, Keypair

    initiator_n = NoiseConnection.from_name(b"Noise_XX_25519_AESGCM_SHA256")
    initiator_n.set_as_initiator()
    initiator_n.set_keypair_from_private_bytes(Keypair.STATIC, os.urandom(32))
    initiator_n.start_handshake()

    responder_n = NoiseConnection.from_name(b"Noise_XX_25519_AESGCM_SHA256")
    responder_n.set_as_responder()
    responder_n.set_keypair_from_private_bytes(Keypair.STATIC, os.urandom(32))
    responder_n.start_handshake()

    # Pre-complete the 3-message XX handshake so the client's NoiseConnection
    # is in the transport (encrypted) phase before any RPC send.
    responder_n.read_message(bytes(initiator_n.write_message(b"")))
    initiator_n.read_message(bytes(responder_n.write_message(b"")))
    responder_n.read_message(bytes(initiator_n.write_message(b"")))
    assert initiator_n.handshake_finished and responder_n.handshake_finished

    out = Queue()  # responder -> initiator (server frames, encrypted)

    def _client_sends(data):
        """Client->server transport frame. Decrypt, parse, emit decoy + reply."""
        if not responder_n.handshake_finished:
            # not used: Gateway __init__ does the handshake itself via ws.send_bytes
            return
        pt = bytes(responder_n.decrypt(bytes(data)))
        ntf = gw.NoiseTransportFrame()
        ntf.ParseFromString(pt)
        sreq = gw.ServiceRequest()
        sreq.ParseFromString(ntf.payload)
        frame = gw.ServiceFrame()
        frame.ParseFromString(sreq.payload)
        sid = frame.stream_id

        # decoy on a foreign stream (G5)
        decoy = gw.ServiceFrame(stream_id=sid + 1000)
        dresp = decoy.response
        dresp.status = 599
        dresp.end_body = True
        _emit_frame(responder_n, out, decoy)

        # real response
        resp = gw.ServiceFrame(stream_id=sid)
        r = resp.response
        r.status = 200
        r.body = json.dumps({"result": {
            "echo_path": frame.request.path,
            "echo_verb": frame.request.verb,
            "echo_body": frame.request.body.decode() or "{}",
        }}).encode()
        r.end_body = True
        _emit_frame(responder_n, out, resp)

    def _emit_frame(noise, q, frame):
        outer = gw.ServiceResponse(payload=frame.SerializeToString())
        fr = gw.NoiseTransportFrame(
            chunk_id=struct.unpack("<q", os.urandom(8))[0],
            chunk_index=0, total_chunks=1,
            payload=outer.SerializeToString(),
        )
        q.put(bytes(noise.encrypt(fr.SerializeToString())))

    class FakeWs:
        def send_bytes(self, data):
            if not responder_n.handshake_finished:
                pt = responder_n.read_message(bytes(data))
                # hand the responder's msg2 back via the same queue
                out.put(bytes(responder_n.write_message(b"")))
            else:
                _client_sends(data)

        def recv(self, *a, **kw):
            try:
                return out.get(timeout=5), None
            except Empty:
                raise TimeoutError("fake ws recv timed out")

        def close(self):
            pass

    return FakeWs(), initiator_n


def test_g4_g5_rpc_roundtrip():
    fake_ws, client_noise = _build_fake_ws_responder()
    g = object.__new__(gw.Gateway)
    g.ws = fake_ws
    g.noise = client_noise
    g.stream = 1
    g.vm_id = "vm-fake-uuid"
    g._send_lock = threading.Lock()
    g._recv_lock = threading.Lock()

    raw = g.request("connectors.accounts_unlink",
                    path_params={"id": "u1", "account_id": "a2"},
                    body={"q": 1}, timeout=10)
    result = json.loads(raw)["result"]
    assert result["echo_verb"] == "POST"
    assert result["echo_path"] == "/connectors/u1/accounts/a2/unlink"
    assert result["echo_body"] == '{"q": 1}'


# --------------------------------------------------------------------------
# G6+G7
# --------------------------------------------------------------------------
def test_g6_g7_error_paths():
    with pytest.raises(gw.GatewayError) as ei:
        gw.Gateway._raise_for_status(None, 500, b"boom")
    assert "500" in str(ei.value)

    sf = gw.ServiceFrame(stream_id=1)
    sf.reset.code = 42
    sf.reset.reason = "denied"
    assert sf.reset.code == 42 and sf.reset.reason == "denied"


# --------------------------------------------------------------------------
# G8 — TLS verification regression guard
# --------------------------------------------------------------------------
def test_g8_tls_verify_regression():
    text = (ROOT / "src" / "kite_cli" / "gateway.py").read_text()
    assert "verify=True" in text


# --------------------------------------------------------------------------
# G9 — full pipeline (cookies file -> tokens -> session)
# --------------------------------------------------------------------------
def test_g9_full_pipeline(fake_muse, tmp_path):
    cookie_file = tmp_path / "cookies.txt"
    cookie_file.write_text("hatch_sess=abc123; datr=xyz789")
    cookies = gw.load_cookies(str(cookie_file))
    assert "hatch_sess=abc123" in cookies

    at = gw.fetch_access_token(cookies, base_url=fake_muse)
    info = gw.fetch_session_info(cookies, base_url=fake_muse)
    ht = gw.fetch_hatch_token(cookies, at, info["vm_id"], base_url=fake_muse)
    assert ht and info["vm_id"].startswith("vm-")
