"""Noise_XX responder for cross-impl interop vector test."""
import sys, socket
sys.path.insert(0, "/mnt/nvme0n1/cell-mirror/noise_build")
from noise_protocol import NoiseHandshakeState
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

STATIC_HEX = sys.argv[1]
EPHEM_HEX = sys.argv[2]
PORT = int(sys.argv[3])

hs = NoiseHandshakeState(
    is_initiator=False,
    static_key=X25519PrivateKey.from_private_bytes(bytes.fromhex(STATIC_HEX)),
    mode="standard",
)
hs.ephemeral_key = X25519PrivateKey.from_private_bytes(bytes.fromhex(EPHEM_HEX))

srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", PORT))
srv.listen(1)
conn, _ = srv.accept()
m1 = b""
while len(m1) < 32:
    chunk = conn.recv(32 - len(m1))
    if not chunk:
        break
    m1 += chunk
hs.read_msg1(bytes(m1))
msg2 = hs.write_msg2()
conn.sendall(len(msg2).to_bytes(2, "big") + msg2)
send_c, recv_c = hs.split()
ln = int.from_bytes(conn.recv(2), "big")
ct = b""
while len(ct) < ln:
    chunk = conn.recv(ln - len(ct))
    if not chunk:
        break
    ct += chunk
pt = recv_c.decrypt_with_ad(b"", bytes(ct))
out = send_c.encrypt_with_ad(b"", pt)
conn.sendall(len(out).to_bytes(2, "big") + out)
srv.close()
conn.close()
