// @toxicwind/kite/interop — cross-impl interop vectors for Noise_XX.
// Runs a live bun ⟺ python SSOT handshake over a socket: proves the bun
// port's transport ciphers are wire-compatible with the proven python SSOT
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

/** Python responder side: reads msg1, writes msg2, then encrypt/decrypt echo. */
export function pythonResponderScript(port: number, staticPrivHex: string): string {
  return `
import sys, socket, threading
sys.path.insert(0, "/mnt/nvme0n1/cell-mirror/noise_build")
from noise_protocol import NoiseHandshakeState
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

static_priv = X25519PrivateKey.from_private_bytes(bytes.fromhex("${staticPrivHex}"))
static_pub = static_priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)

srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", ${port})); srv.listen(1)
conn, _ = srv.accept()
hs = NoiseHandshakeState(is_initiator=False, static_key=static_priv, mode="standard")
msg1 = conn.recv(64)
payload = hs.read_msg1(msg1)
msg2 = hs.write_msg2()
conn.sendall(msg2)
# now encrypted echo: recv ct, decrypt, re-encrypt, send back
send_c, recv_c = hs.split()
while True:
  ct = b""
  while len(ct) < 48 + 16:
    chunk = conn.recv(48 + 16 - len(ct))
    if not chunk: break
    ct += chunk
  if not ct: break
  pt = recv_c.decrypt_with_ad(b"", bytes(ct))
  out = send_c.encrypt_with_ad(b"", pt)
  conn.sendall(out)
srv.close()
`;
}

/** Bun initiator: connect, handshake, then encrypted round-trip both ways. */
export async function bunInitiator(port: number): Promise<{ bunPlaintext: string; pyPlaintext: string }> {
  const mod = await import("./noise.ts");
  const { NoiseHandshakeState } = mod;
  const alice = new NoiseHandshakeState({ isInitiator: true, mode: "standard", staticKey: { private: STATIC_PRIV.private, publicRaw: STATIC_PRIV.publicRaw } });
  const sock = await new Promise<Socket>((res, rej) => {
    const s = createServer().address() as any; // noop, keep type happy
    const c = new Socket();
    c.connect(port, "127.0.0.1", () => res(c));
    c.on("error", rej);
  });
  sock.setTimeout(10000);
  sock.write(alice.writeMsg1());
  const msg2 = await readExact(sock, 80);
  const r3 = alice.readMsg2(msg2);
  const { send: aliceSend, recv: aliceRecv } = alice.writeMsg3(r3.msg);

  const ping = Buffer.from("tau->kappa-interop-vector");
  const ctPing = aliceSend.encryptWithAd(Buffer.alloc(0), ping);
  sock.write(ctPing);
  const ctPong = await readExact(sock, ctPing.length);
  const pong = aliceRecv.decryptWithAd(Buffer.alloc(0), ctPong);

  const pyPlaintext = aliceRecv.decryptWithAd(Buffer.alloc(0), await readExact(sock, 48 + 16)); // python's echo of ping (48B ct + tag)
  sock.end();
  return { bunPlaintext: pong.toString("utf8"), pyPlaintext: pyPlaintext.toString("utf8") };
}

function readExact(sock: Socket, n: number): Promise<Buffer> {
  return new Promise((res, rej) => {
    const parts: Buffer[] = []; let got = 0;
    sock.on("data", (d) => { parts.push(d); got += d.length; if (got >= n) res(Buffer.concat(parts).subarray(0, n)); });
    sock.on("error", rej);
    sock.on("end", () => res(Buffer.concat(parts)));
    setTimeout(() => rej(new Error("readExact timeout")), 10000);
  });
}

/** Run the full cross-impl vector: python responder + bun initiator. */
export async function runInteropVector(port = 33771): Promise<VectorResult> {
  try {
    const { execSync } = await import("child_process");
    const staticPrivHex = STATIC_PRIV.publicRaw.toString("hex"); // placeholder, replaced below
    // use the private key raw bytes (32B) — STATIC_PRIV.private is KeyObject; export raw:
    const privRaw = STATIC_PRIV.private.export({ type: "pkcs8", format: "der" }).subarray(-32);
    execSync(`python3 -c "${pythonResponderScript(port, privRaw.toString("hex"))}" &`, { timeout: 1000 });
    await new Promise(r => setTimeout(r, 600));
    const out = await bunInitiator(port);
    return { ok: out.bunPlaintext === "kappa->tau-interop" && out.pyPlaintext === "tau->kappa-interop", ...out };
  } catch (e) { return { ok: false, reason: String(e) }; }
}
