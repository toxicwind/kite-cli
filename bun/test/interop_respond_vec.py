"""Responder side: reads msg1 (hex arg), writes msg2 (hex to stdout)."""
import sys, json
sys.path.insert(0, "/mnt/nvme0n1/cell-mirror/noise_build")
from noise_protocol import NoiseHandshakeState
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

STATIC_HEX, EPHEM_HEX, MSG1_HEX = sys.argv[1], sys.argv[2], sys.argv[3]

hs = NoiseHandshakeState(
    is_initiator=False,
    static_key=X25519PrivateKey.from_private_bytes(bytes.fromhex(STATIC_HEX)),
    mode="standard",
)
hs.ephemeral_key = X25519PrivateKey.from_private_bytes(bytes.fromhex(EPHEM_HEX))
msg1 = bytes.fromhex(MSG1_HEX)
payload = hs.read_msg1(msg1)
msg2 = hs.write_msg2()
print(json.dumps({"ok": True, "stage": hs.stage, "payloadLen": len(payload), "msg2": msg2.hex()}))
