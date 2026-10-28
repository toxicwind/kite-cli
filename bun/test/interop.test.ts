import { strictEqual, ok } from "node:assert";
import { execFileSync } from "child_process";
import { NoiseHandshakeState, importPublicRaw, importPrivateRaw, rawPublic } from "../src/noise.ts";

const STATIC = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));   // fixed static key
const EPHEM = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 33));    // fixed ephemeral key

test("interop-vector: fixed-key msg1 matches python SSOT byte-for-byte", () => {
  const pythonMsg1 = execFileSync("python3", ["/home/toxic/pens/hatch-kite-cli/bun/test/interop_vector.py", STATIC.toString("hex"), EPHEM.toString("hex")], { encoding: "utf8", maxBuffer: 1 << 20 }).trim();

  const bunState = new NoiseHandshakeState({
    isInitiator: true,
    mode: "standard",
    staticKey: { private: importPrivateRaw(STATIC), publicRaw: rawPublic(importPrivateRaw(STATIC)) },
  });
  bunState.ephemeral = { private: importPrivateRaw(EPHEM), publicRaw: rawPublic(importPrivateRaw(EPHEM)) };
  const bunMsg1 = bunState.writeMsg1();

  strictEqual(bunMsg1.toString("hex"), pythonMsg1, "msg1 must be identical before any transport test");
});

test("interop-vector: full XX handshake bun↔python (msg1 both ways)", async () => {
  const { execSync } = await import("child_process");
  // python responder: reads our msg1, writes msg2; asserts via exit code
  const alice = new NoiseHandshakeState({
    isInitiator: true,
    mode: "standard",
    staticKey: { private: importPrivateRaw(STATIC), publicRaw: rawPublic(importPrivateRaw(STATIC)) },
  });
  alice.ephemeral = { private: importPrivateRaw(EPHEM), publicRaw: rawPublic(importPrivateRaw(EPHEM)) };
  const bunMsg1 = alice.writeMsg1();

  const pyOut = execFileSync("python3", [
    "/home/toxic/pens/hatch-kite-cli/bun/test/interop_respond_vec.py",
    STATIC.toString("hex"), EPHEM.toString("hex"),
    bunMsg1.toString("hex"),
  ], { encoding: "utf8", maxBuffer: 1 << 20, timeout: 15000 }).trim();

  const pyJson = JSON.parse(pyOut);
  strictEqual(pyJson.ok, true);
  strictEqual(pyJson.stage, 2);

  // bun consumes python's msg2
  const msg2 = Buffer.from(pyJson.msg2, "hex");
  const r3 = alice.readMsg2(msg2);
  strictEqual(alice.completed, true);
  strictEqual(r3.msg.length, 48); // standard: sEnc(32+16=48)
});
