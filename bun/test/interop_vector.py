# interop-vector python SSOT runner (fixed static, pinned ephemeral).
# Usage:
#   interop_vector.py <static_hex> <ephem_hex>   -> prints msg1 hex ONLY (kappa contract)
#   interop_vector.py                            -> prints MSG1:/H: labeled (tau gate incl. running hash)
import sys

sys.path.insert(0, "/mnt/nvme0n1/cell-mirror/noise_build")
import noise_protocol as np  # noqa: E402
import cryptography.hazmat.primitives.asymmetric.x25519 as x  # noqa: E402

static_hex = sys.argv[1] if len(sys.argv) > 1 else bytes(range(1, 33)).hex()
ephem_hex = sys.argv[2] if len(sys.argv) > 2 else bytes(range(33, 65)).hex()

i = np.NoiseHandshakeState(
    is_initiator=True,
    static_key=x.X25519PrivateKey.from_private_bytes(bytes.fromhex(static_hex)),
    mode="standard",
)
i.ephemeral_key = x.X25519PrivateKey.from_private_bytes(bytes.fromhex(ephem_hex))
m1 = i.write_msg1()
if len(sys.argv) > 1:
    print(m1.hex())
else:
    print("MSG1:" + m1.hex())
    print("H:" + i.symmetric_state.h.hex())
