# interop-vector python SSOT runner (fixed static bytes 1..32, pinned ephemeral 33..64).
# Byte-compare targets for test/interop-vector.test.ts. SSOT: /mnt/nvme0n1/cell-mirror/noise_build.
import sys

sys.path.insert(0, "/mnt/nvme0n1/cell-mirror/noise_build")
import noise_protocol as np  # noqa: E402
import cryptography.hazmat.primitives.asymmetric.x25519 as x  # noqa: E402

i = np.NoiseHandshakeState(
    is_initiator=True,
    static_key=x.X25519PrivateKey.from_private_bytes(bytes(range(1, 33))),
    mode="standard",
)
i.ephemeral_key = x.X25519PrivateKey.from_private_bytes(bytes(range(33, 65)))
m1 = i.write_msg1()
print("MSG1:" + m1.hex())
print("H:" + i.symmetric_state.h.hex())
