# interop_responder.py — LIVE python SSOT Noise_XX responder over TCP (kappa wire contract):
#   recv 32B msg1 (raw) -> send u16be msg2 -> recv u16be msg3 -> split -> echo u16be frames.
# Usage: interop_responder.py <static_hex> <ephemeral_hex> <port>
import socket
import struct
import sys

sys.path.insert(0, "/mnt/nvme0n1/cell-mirror/noise_build")
import noise_protocol as np  # noqa: E402
import cryptography.hazmat.primitives.asymmetric.x25519 as x  # noqa: E402

static_hex, ephem_hex, port = sys.argv[1], sys.argv[2], int(sys.argv[3])

r = np.NoiseHandshakeState(
    is_initiator=False,
    static_key=x.X25519PrivateKey.from_private_bytes(bytes.fromhex(static_hex)),
    mode="standard",
)
r.ephemeral_key = x.X25519PrivateKey.from_private_bytes(bytes.fromhex(ephem_hex))

srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", port))
srv.listen(1)

conn, _ = srv.accept()
buf = b""


def recv_exact(n: int) -> bytes:
    global buf
    while len(buf) < n:
        chunk = conn.recv(4096)
        if not chunk:
            raise SystemExit("peer closed")
        buf += chunk
    out, buf = buf[:n], buf[n:]
    return out


def recv_frame() -> bytes:
    (n,) = struct.unpack(">H", recv_exact(2))
    return recv_exact(n)


# handshake: msg1 raw 32B (XX standard, empty payload), msg2 u16be-framed, msg3 u16be-framed
r.read_msg1(recv_exact(32))
msg2 = r.write_msg2()
conn.sendall(struct.pack(">H", len(msg2)) + msg2)
read_msg3_ret = r.read_msg3(recv_frame())
rx, tx = read_msg3_ret[1]  # (plaintext, (recv_cipher, send_cipher))

# transport: decrypt each frame, echo re-encrypted
while True:
    try:
        frame = recv_frame()
    except SystemExit:
        break
    pt = rx.decrypt_with_ad(b"", frame)
    ct = tx.encrypt_with_ad(b"", pt)
    conn.sendall(struct.pack(">H", len(ct)) + ct)
conn.close()
