// @toxicwind/kite/transport — pure-NODE x25519 helpers the bun port can't
// express cleanly on this build (raw JWK import is restricted).
// ECDH x25519: setPrivateKey(raw scalar) -> getPublicKey() raw 32 bytes.
// Mirrors python X25519PrivateKey.from_private_bytes / .public_key().
import { createECDH } from "node:crypto";

export function scalarToPublicRaw(scalar: Buffer): Buffer {
  const ecdh = createECDH("x25519");
  ecdh.setPrivateKey(scalar);
  return Buffer.from(ecdh.getPublicKey());
}
