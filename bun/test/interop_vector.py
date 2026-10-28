"""Fixed-key Noise_XX initiator side (run standalone for debugging): prints msg1 hex."""
import sys
sys.path.insert(0, "/mnt/nvme0n1/cell-mirror/noise_build")
from noise_protocol import NoiseHandshakeState
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

STATIC_HEX = sys.argv[1]
EPHEM_HEX = sys.argv[2]

hs = NoiseHandshakeState(
    is_initiator=True,
    static_key=X25519PrivateKey.from_private_bytes(bytes.fromhex(STATIC_HEX)),
    mode="standard",
)
hs.ephemeral_key = X25519PrivateKey.from_private_bytes(bytes.fromhex(EPHEM_HEX))
print(hs.write_msg1().hex())
