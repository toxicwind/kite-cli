import { strictEqual, ok } from "node:assert";
import { execFileSync, spawn } from "child_process";
import { Socket } from "net";
import { NoiseHandshakeState } from "../src/noise.ts";

const STATIC = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));   // fixed static key
const EPHEM = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 33));    // fixed ephemeral key

test("interop-vector: fixed-key msg1 matches python SSOT byte-for-byte", () => {
  const pythonMsg1 = execFileSync("python3", ["/home/toxic/pens/hatch-kite-cli/bun/test/interop_vector.py", STATIC.toString("hex"), EPHEM.toString("hex")], { encoding: "utf8", maxBuffer: 1 << 20 }).trim();

  const bunState = new NoiseHandshakeState({
    isInitiator: true,
    mode: "standard",
    staticKey: { private: importPrivateRaw(STATIC), publicRaw: importPublicRaw(STATIC) },
  });
  bunState.ephemeral = { private: importPrivateRaw(EPHEM), publicRaw: importPublicRaw(EPHEM) };
  const bunMsg1 = bunState.writeMsg1();

  strictEqual(bunMsg1.toString("hex"), pythonMsg1, "msg1 must be identical before any transport test");
});

test("interop-vector: live bun<->python XX round-trip with encrypted echo", async () => {
  const port = 33773;
  const { spawn } = await import("child_process");
  spawn("python3", [
    "/home/toxic/pens/hatch-kite-cli/bun/test/interop_responder.py",
    STATIC.toString("hex"), EPHEM.toString("hex"), String(port),
  ], { stdio: "ignore", detached: true }).unref();

  // wait for responder to bind
  for (let i = 0; i < 20; i++) {
    try {
      const probe = new Socket();
      await new Promise<void>((res, rej) => { probe.connect(port, "127.0.0.1", res); probe.on("error", rej); probe.setTimeout(500, () => probe.destroy()); });
      probe.end();
      break;
    } catch { await new Promise(r => setTimeout(r, 250)); }
  }

  const alice = new NoiseHandshakeState({
    isInitiator: true,
    mode: "standard",
    staticKey: { private: importPrivateRaw(STATIC), publicRaw: importPublicRaw(STATIC) },
  });
  alice.ephemeral = { private: importPrivateRaw(EPHEM), publicRaw: importPublicRaw(EPHEM) };

  const sock = new Socket();
  await new Promise<void>((res, rej) => { sock.connect(port, "127.0.0.1", res); sock.on("error", rej); });
  sock.setTimeout(10000);

  sock.write(alice.writeMsg1());
  const ln2 = await readExact(sock, 2);
  const n2 = ln2.readUInt16BE(0);
  const msg2 = await readExact(sock, n2);
  const r3 = alice.readMsg2(msg2);
  const { send: aliceSend, recv: aliceRecv } = alice.writeMsg3(r3.msg);

  const ping = Buffer.from("tau->kappa-interop-vector");
  const ctPing = aliceSend.encryptWithAd(Buffer.alloc(0), ping);
  sock.write(Buffer.from([ctPing.length >> 8, ctPing.length & 0xff]));
  sock.write(ctPing);
  const lnPong = await readExact(sock, 2);
  const np = lnPong.readUInt16BE(0);
  const ctPong = await readExact(sock, np);
  const pong = aliceRecv.decryptWithAd(Buffer.alloc(0), ctPong);

  sock.end();
  ok(pong.length > 0);
  strictEqual(pong.toString("utf8"), "tau->kappa-interop-vector");
});

async function readExact(sock: Socket, n: number): Promise<Buffer> {
  return new Promise((res, rej) => {
    const parts: Buffer[] = []; let got = 0;
    sock.on("data", (d) => { parts.push(d); got += d.length; if (got >= n) res(Buffer.concat(parts).subarray(0, n)); });
    sock.on("error", rej);
    setTimeout(() => rej(new Error("readExact timeout")), 10000);
  });
}
