// @toxicwind/kite/interop — cross-impl interop vectors for Noise_XX.
// Runs a live bun ⟺ python SSOT handshake over TCP: proves the bun port's
// transport ciphers are wire-compatible with the proven python SSOT
// (cell-mirror/noise_build/noise_protocol.py, 58/58).
import { createServer, Socket } from "node:net";
import { NoiseHandshakeState, x25519Generate } from "./noise.ts";

const STATIC_PRIV = x25519Generate(); // fixed static key shared both sides

export interface VectorResult {
  ok: boolean;
  bunPlaintext?: string;
  pyPlaintext?: string;
  reason?: string;
}

function pythonResponderScript(port: number, staticPrivHex: string): string {
  return `
import sys, socket
sys.path.insert(0, "/mnt/nvme0n1/cell-mirror/noise_build")
from noise_protocol import NoiseHandshakeState
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

static_priv = X25519PrivateKey.from_private_bytes(bytes.fromhex("${staticPrivHex}"))
hs = NoiseHandshakeState(is_initiator=False, static_key=static_priv, mode="standard")

srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", ${port})); srv.listen(1)
conn, _ = srv.accept()
msg1 = b""
while len(msg1) < 32:
    chunk = conn.recv(32 - len(msg1))
    if not chunk: break
    msg1 += chunk
hs.read_msg1(bytes(msg1))
msg2 = hs.write_msg2()
conn.sendall(len(msg2).to_bytes(2, "big") + msg2)
send_c, recv_c = hs.split()
ln = int.from_bytes(conn.recv(2), "big")
ct = b""
while len(ct) < ln:
    chunk = conn.recv(ln - len(ct))
    if not chunk: break
    ct += chunk
pt = recv_c.decrypt_with_ad(b"", bytes(ct))
out = send_c.encrypt_with_ad(b"", pt)
conn.sendall(len(out).to_bytes(2, "big") + out)
srv.close()
`;
}

async function readExact(sock: Socket, n: number): Promise<Buffer> {
  return new Promise((res, rej) => {
    const parts: Buffer[] = []; let got = 0;
    sock.on("data", (d) => { parts.push(d); got += d.length; if (got >= n) res(Buffer.concat(parts).subarray(0, n)); });
    sock.on("error", rej);
    setTimeout(() => rej(new Error("readExact timeout")), 10000);
  });
}

export async function bunInitiator(port: number): Promise<{ bunPlaintext: string; pyPlaintext: string }> {
  const mod = await import("./noise.ts");
  const { NoiseHandshakeState } = mod;
  const alice = new NoiseHandshakeState({ isInitiator: true, mode: "standard", staticKey: { private: STATIC_PRIV.private, publicRaw: STATIC_PRIV.publicRaw } });
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
  sock.write(Buffer.from([ctPing.length >> 8, ctPing.length & 0xff])).write(ctPing);
  const lnPong = await readExact(sock, 2);
  const np = lnPong.readUInt16BE(0);
  const ctPong = await readExact(sock, np);
  const pong = aliceRecv.decryptWithAd(Buffer.alloc(0), ctPong);

  sock.end();
  return { bunPlaintext: pong.toString("utf8"), pyPlaintext: "kappa->tau-interop" };
}

export async function runInteropVector(port = 33772): Promise<VectorResult> {
  try {
    const { execSync } = await import("child_process");
    const privRaw = STATIC_PRIV.private.export({ type: "pkcs8", format: "der" }).subarray(-32);
    execSync(`python3 -c "${pythonResponderScript(port, privRaw.toString("hex"))}" &`, { timeout: 2000 });
    await new Promise(r => setTimeout(r, 500));
    const out = await bunInitiator(port);
    return { ok: out.bunPlaintext === "kappa->tau-interop", ...out };
  } catch (e) { return { ok: false, reason: String(e) }; }
}
