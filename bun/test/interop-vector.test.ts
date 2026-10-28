// interop-vector: bun port vs python SSOT (/mnt/nvme0n1/cell-mirror/noise_build).
// Per skill methodology: fixed static (bytes 1..32) AND pinned ephemeral (bytes 33..64);
// byte-compare msg1 + running hash h. Skips honestly if SSOT mirror absent.
import { test, expect } from "bun:test";
import { NoiseHandshakeState } from "../src/noise";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync } from "node:fs";

const SSOT = "/mnt/nvme0n1/cell-mirror/noise_build/noise_protocol.py";
const PKCS8 = (raw: Buffer) => Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), raw]);

function bunSide(): { msg1: string; h: string } {
  const stat = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
  const eph = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 33));
  const hs = new NoiseHandshakeState({
    isInitiator: true, mode: "standard",
    staticKey: { private: createPrivateKey({ key: PKCS8(stat), format: "der", type: "pkcs8" }), publicRaw: stat },
  });
  const ephPriv = createPrivateKey({ key: PKCS8(eph), format: "der", type: "pkcs8" });
  const spki = createPublicKey(ephPriv).export({ type: "spki", format: "der" }) as Buffer;
  hs.ephemeral = { private: ephPriv, publicRaw: spki.subarray(spki.length - 32) };
  const m1 = hs.writeMsg1();
  return { msg1: m1.toString("hex"), h: (hs as unknown as { ss: { h: Buffer } }).ss.h.toString("hex") };
}

test("interop: bun msg1 == python SSOT msg1 (fixed static + pinned ephemeral, byte-exact)", async () => {
  if (!existsSync(SSOT)) { console.log("SKIP: SSOT mirror not mounted"); return; }
  const out = await Bun.$`python3 ${import.meta.dir}/fixtures/interop_vector.py`.text();
  const pyMsg1 = /MSG1:([0-9a-f]+)/.exec(out)?.[1];
  const pyH = /H:([0-9a-f]+)/.exec(out)?.[1];
  expect(pyMsg1).toBeDefined();
  const bun = bunSide();
  expect(bun.msg1).toBe(pyMsg1!);           // handshake stage 1: byte-exact across impls
  expect(bun.h).toBe(pyH!);                 // running hash agrees => DH + mixKey/mixHash chain identical
});
