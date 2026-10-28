// @toxicwind/kite/gateway — the REAL muse.ai/hatch gateway RPC over wss noise.
// Faithful Bun port of noise_build/gateway_rpc.py (the proven protocol):
//   wss://hatch.metaaivm.com/v1/noise?vm_id=..&auth_token=..
//   NoiseTransportFrame{chunk_id=1, chunk_index=2, total_chunks=3, payload=4}
//   ServiceFrame{stream_id=1, request=2, response=3}
//   ServiceRequest{service=1, payload=2} / ServiceResponse{payload=1}
//   ApplicationRequest{verb=1, path=2, headers=3, body=4, end_body=5}
//   ApplicationResponse{status=1, headers=2, body=3, end_body=4}
//   SERVICES = { daemon: 0, sentinel: 1, vault: 2, authd: 3 }
// Handshake: XX with EMPTY payloads; transport ciphers from split().
// Chunking: plaintext chunks of frame_max-32, each a NoiseTransportFrame,
// encrypted (AD="") into ONE websocket binary frame per chunk.

import { NoiseHandshakeState } from "./noise.ts";

export const SERVICES = { daemon: 0, sentinel: 1, vault: 2, authd: 3 } as const;
export type ServiceName = keyof typeof SERVICES;
export const FRAME_MAX_BYTES = 65535;

export const DEFAULT_GATEWAY = "wss://hatch.metaaivm.com/v1/noise";
export const DEFAULT_VM_ID = "f7bacd97-627d-431d-8c37-4615b99ef312";

// --- minimal protobuf (varint + length-delimited only — same as python) ---
export function pbVarint(n: number): Buffer {
  let v = n < 0 ? n >>> 0 : n;
  if (n < 0) v = n + 0x10000000000000000; // two's complement for i64
  const out: number[] = [];
  let x = BigInt(Math.round(n));
  if (n < 0) x = x & 0xffffffffffffffffn;
  for (;;) {
    const b = Number(x & 0x7fn);
    x >>= 7n;
    if (x) out.push(b | 0x80); else { out.push(b); break; }
  }
  void v;
  return Buffer.from(out);
}

export function pbDecodeVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0n, shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error("truncated varint");
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [Number(result), pos];
    shift += 7n;
    if (shift >= 64n) throw new Error("varint overflow");
  }
}

export function pbField(num: number, wire: 0 | 2, value: number | Buffer | string): Buffer {
  const tag = pbVarint((num << 3) | wire);
  if (wire === 0) return Buffer.concat([tag, pbVarint(value as number)]);
  const v = typeof value === "string" ? Buffer.from(value) : value as Buffer;
  return Buffer.concat([tag, pbVarint(v.length), v]);
}

export function pbFields(buf: Buffer): Map<number, number | Buffer> {
  const out = new Map<number, number | Buffer>();
  let pos = 0;
  while (pos < buf.length) {
    const [tag, p1] = pbDecodeVarint(buf, pos);
    const num = tag >> 3, wire = tag & 7;
    pos = p1;
    if (wire === 0) { const [v, p2] = pbDecodeVarint(buf, pos); out.set(num, v); pos = p2; }
    else if (wire === 2) { const [ln, p2] = pbDecodeVarint(buf, pos); out.set(num, buf.subarray(p2, p2 + ln)); pos = p2 + ln; }
    else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

// --- protocol frames ---
export function frameEncode(chunkId: number, chunkIndex: number, totalChunks: number, payload: Buffer): Buffer {
  return Buffer.concat([
    pbField(1, 0, chunkId), pbField(2, 0, chunkIndex), pbField(3, 0, totalChunks), pbField(4, 2, payload),
  ]);
}

export function frameDecode(buf: Buffer): [number, number, number, Buffer] {
  const d = pbFields(buf);
  return [d.get(1) as number, d.get(2) as number, d.get(3) as number, d.get(4) as Buffer ?? Buffer.alloc(0)];
}

export function appRequestEncode(verb: string, path: string, headers: Buffer, body: Buffer): Buffer {
  return Buffer.concat([
    pbField(1, 2, verb), pbField(2, 2, path), pbField(3, 2, headers),
    pbField(4, 2, body), pbField(5, 0, 1),
  ]);
}

export function appResponseDecode(buf: Buffer): { status: number; headers: Buffer; body: Buffer; endBody: number } {
  const d = pbFields(buf);
  return {
    status: (d.get(1) as number) ?? 0,
    headers: (d.get(2) as Buffer) ?? Buffer.alloc(0),
    body: (d.get(3) as Buffer) ?? Buffer.alloc(0),
    endBody: (d.get(4) as number) ?? 0,
  };
}

export function serviceRequestEncode(service: number, streamId: number, appRequest: Buffer): Buffer {
  const frame = Buffer.concat([pbField(1, 0, streamId), pbField(2, 2, appRequest)]);
  return Buffer.concat([pbField(1, 0, service), pbField(2, 2, frame)]);
}

export function serviceResponseDecode(buf: Buffer): { streamId: number; appResponse: Buffer } {
  const d = pbFields(buf);
  const frame = pbFields(d.get(1) as Buffer);
  return { streamId: frame.get(1) as number, appResponse: frame.get(3) as Buffer ?? Buffer.alloc(0) };
}

// --- GatewayClient (standard mode per the independently verified doc) ---
export interface GatewayOpts {
  url?: string;
  vmId?: string;
  authToken?: string;          // HATCH_AUTH_TOKEN — used, never logged
  mode?: "standard" | "custom";
  sock?: { send(b: Buffer): void; recv(): Buffer | Promise<Buffer> };  // injected transport (tests)
  frameMax?: number;
}

export class GatewayClient {
  private sendCipher: import("./noise.ts").CipherState | null = null;
  private recvCipher: import("./noise.ts").CipherState | null = null;
  private ws: WebSocket | null = null;
  private injected: GatewayOpts["sock"] | null = null;
  private streamId = 0;
  private chunkId = 0;
  private pending: Array<(data: Buffer | null) => void> = [];
  private frameMax: number;

  constructor(private opts: GatewayOpts = {}) {
    this.frameMax = opts.frameMax ?? FRAME_MAX_BYTES;
    if (opts.sock) this.injected = opts.sock;
  }

  async connect(timeoutMs = 20000): Promise<this> {
    if (this.injected) { await this.handshake(b => this.injected!.send(b), () => this.injected!.recv()); return this; }
    const url = `${this.opts.url ?? DEFAULT_GATEWAY}?vm_id=${this.opts.vmId ?? DEFAULT_VM_ID}&auth_token=${this.opts.authToken ?? process.env.HATCH_AUTH_TOKEN ?? ""}`;
    const ws = new WebSocket(url, { protocols: [] } as never);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("gateway ws timeout")), timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(t); res(); });
      ws.addEventListener("error", () => { clearTimeout(t); rej(new Error("gateway ws error")); });
    });
    ws.addEventListener("message", ev => {
      const data = Buffer.from(ev.data as ArrayBuffer);
      const r = this.pending.shift();
      if (r) r(data);
    });
    ws.addEventListener("close", () => { while (this.pending.length) this.pending.shift()!(null); });
    this.ws = ws;
    await this.handshake(b => ws.send(b), () => new Promise<Buffer>((res, rej) => {
      this.pending.push(d => d ? res(d) : rej(new Error("connection closed")));
    }));
    return this;
  }

  private async handshake(send: (b: Buffer) => void, recv: () => Buffer | Promise<Buffer>) {
    const hs = new NoiseHandshakeState({ isInitiator: true, mode: this.opts.mode ?? "standard" });
    send(hs.writeMsg1());
    hs.readMsg2(Buffer.from(await recv()));
    const { msg, send: sc, recv: rc } = hs.writeMsg3();
    send(msg);
    this.sendCipher = sc; this.recvCipher = rc;
  }

  /** Encrypt + chunk + send one plaintext message (NoiseTransportFrames). */
  async sendFramePlaintext(plaintext: Buffer): Promise<void> {
    if (!this.sendCipher) throw new Error("not connected");
    const chunkSize = this.frameMax - 32;
    const chunks = plaintext.length === 0 ? [Buffer.alloc(0)]
      : Array.from({ length: Math.ceil(plaintext.length / chunkSize) }, (_, i) => plaintext.subarray(i * chunkSize, (i + 1) * chunkSize));
    const cid = ++this.chunkId;
    for (let idx = 0; idx < chunks.length; idx++) {
      const ct = this.sendCipher.encryptWithAd(Buffer.alloc(0), frameEncode(cid, idx, chunks.length, chunks[idx]));
      this.injected ? this.injected.send(ct) : this.ws!.send(ct);
    }
  }

  /** Read + reassemble one full chunked message (stateful decrypt: serialized). */
  async recvFramePlaintext(): Promise<Buffer> {
    if (!this.recvCipher) throw new Error("not connected");
    const parts = new Map<number, Buffer>();
    let total: number | null = null, cid: number | null = null;
    for (;;) {
      const ct = this.injected ? await this.injected.recv() : await new Promise<Buffer>((res, rej) => this.pending.push(d => d ? res(d) : rej(new Error("connection closed"))));
      const frame = frameDecode(this.recvCipher.decryptWithAd(Buffer.alloc(0), ct));
      const [fcid, idx, ftotal, payload] = frame;
      if (cid === null) { cid = fcid; total = ftotal; }
      if (fcid !== cid) throw new Error(`chunk stream interleave: ${fcid} != ${cid}`);
      parts.set(idx, payload);
      if (parts.size === total) return Buffer.concat(Array.from({ length: total! }, (_, i) => parts.get(i)!));
    }
  }

  /** Unary RPC: one ServiceRequest; collect ServiceResponses until end_body. */
  async call(service: ServiceName, verb: string, path: string, body = Buffer.alloc(0), headers = Buffer.alloc(0), timeoutMs = 30000) {
    const sid = ++this.streamId;
    const req = serviceRequestEncode(SERVICES[service], sid, appRequestEncode(verb, path, headers, body));
    await this.sendFramePlaintext(req);
    const deadline = Date.now() + timeoutMs;
    let status = 0, respHeaders = Buffer.alloc(0);
    const bodyParts: Buffer[] = [];
    for (;;) {
      if (Date.now() > deadline) throw new Error("rpc timeout");
      const [, app] = serviceResponseDecode(await this.recvFramePlaintext());
      const r = appResponseDecode(app);
      status = r.status; respHeaders = r.headers;
      if (r.body.length) bodyParts.push(r.body);
      if (r.endBody) break;
    }
    return { streamId: sid, status, headers: respHeaders, body: Buffer.concat(bodyParts) };
  }

  close() { this.ws?.close(); this.ws = null; }
}
