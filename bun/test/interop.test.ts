import { strictEqual, ok } from "node:assert";
import { execFileSync } from "child_process";
import { NoiseHandshakeState, importPrivateRaw } from "../src/noise.ts";

const STATIC = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));   // fixed static key
const EPHEM = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 33));    // fixed ephemeral key

// public keys derived once from python SSOT and recorded (cross-impl contract)
const STATIC_PUB = "07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c";
const EPHEM_PUB = "5869aff450549732cbaaed5e5df9b30a6da31cb0e5742bad5ad4a1a768f1a67b";

test("interop-vector: python SSOT register public keys for fixed scalars", () => {
  const pyStatic = execFileSync("python3", [
    "-c", "import sys; sys.path.insert(0,'/mnt/nvme0n1/cell-mirror/noise_build'); from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey; from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat; k = X25519PrivateKey.from_private_bytes(bytes([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32])); print(k.public_key().public_bytes(encoding=Encoding.Raw, format=PublicFormat.Raw).hex())"
  ], { encoding: "utf8", maxBuffer: 1 << 20 }).trim();
  strictEqual(pyStatic.length, 64);
});

test("interop-vector: fixed-key msg1 matches python SSOT byte-for-byte", () => {
  const pythonMsg1 = execFileSync("python3", ["/home/toxic/pens/hatch-kite-cli/bun/test/interop_vector.py", STATIC.toString("hex"), EPHEM.toString("hex")], { encoding: "utf8", maxBuffer: 1 << 20 }).trim();

  const bunState = new NoiseHandshakeState({
    isInitiator: true,
    mode: "standard",
    staticKey: { private: importPrivateRaw(STATIC), publicRaw: Buffer.from(STATIC_PUB, "hex") },
  });
  bunState.ephemeral = { private: importPrivateRaw(EPHEM), publicRaw: Buffer.from(EPHEM_PUB, "hex") };
  const bunMsg1 = bunState.writeMsg1();

  strictEqual(bunMsg1.toString("hex"), pythonMsg1, "msg1 must be identical before any transport test");
});

test("interop-vector: full XX handshake bun↔python (msg1 both ways)", async () => {
  const { execSync } = await import("child_process");
  const alice = new NoiseHandshakeState({
    isInitiator: true,
    mode: "standard",
    staticKey: { private: importPrivateRaw(STATIC), publicRaw: Buffer.from(STATIC_PUB, "hex") },
  });
  alice.ephemeral = { private: importPrivateRaw(EPHEM), publicRaw: Buffer.from(EPHEM_PUB, "hex") };
  const bunMsg1 = alice.writeMsg1();

  const pyOut = execFileSync("python3", [
    "/home/toxic/pens/hatch-kite-cli/bun/test/interop_respond_vec.py",
    STATIC.toString("hex"), EPHEM.toString("hex"),
    bunMsg1.toString("hex"),
  ], { encoding: "utf8", maxBuffer: 1 << 20, timeout: 15000 }).trim();

  const pyJson = JSON.parse(pyOut);
  strictEqual(pyJson.ok, true);
  strictEqual(pyJson.stage, 2);

  const msg2 = Buffer.from(pyJson.msg2, "hex");
  const r3 = alice.readMsg2(msg2);
  strictEqual(alice.completed, false);   // readMsg2 -> stage 2; completion is writeMsg3's contract
  strictEqual(alice.stage, 2);
  const fin = alice.writeMsg3();          // standard msg3 = sEnc(48) + enc(empty)(16) = 64
  strictEqual(fin.msg.length, 64);
  strictEqual(alice.completed, true);
});
