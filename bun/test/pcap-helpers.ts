// shared pcapng fixture helpers (kappa contract, tau implementation)
import { Buffer } from "node:buffer";

export function ethFrame(src: Buffer, dst: Buffer, ethertype: number, payload: Buffer): Buffer {
  return Buffer.concat([dst, src, Buffer.from([ethertype >> 8, ethertype & 0xff]), payload]);
}

export function ipv4Packet(totalLen: number, proto: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(20);
  h[0] = 0x45; // version 4 high nibble, IHL 5 low nibble (was nibble-swapped — fleet-found bug)
  h.writeUInt16BE(totalLen, 2);
  h.writeUInt16BE(0x4000, 6);
  h[8] = 64;
  h[9] = proto;
  h[14] = 10; h[15] = 0; h[16] = 0; h[17] = 1;
  h[18] = 10; h[19] = 0; h[20] = 0; h[21] = 2;
  return Buffer.concat([h, payload]);
}

export function tcpSegment(sport: number, dport: number, seq: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(20);
  h.writeUInt16BE(sport, 0);
  h.writeUInt16BE(dport, 2);
  h.writeUInt32BE(seq, 4);
  h[12] = 5 << 4;
  h[13] = 0x10;
  h.writeUInt16BE(8192, 14);
  return Buffer.concat([h, payload]);
}

export function makePcapng(frames: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  const body = Buffer.concat([Buffer.from([1, 0]), Buffer.from([0, 0]), Buffer.from([1, 0]), Buffer.from([0, 0]), Buffer.from([0, 0])]);
  const sl = 4 + 4 + body.length + 4;
  const le = (v: number) => Buffer.from([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);
  parts.push(Buffer.concat([Buffer.from([0xa, 0, 0, 0]), le(sl), body, le(sl)]));
  const body2 = Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from([0, 0, 0, 0])]);
  const sl2 = 4 + 4 + body2.length + 4;
  parts.push(Buffer.concat([Buffer.from([0x1, 0, 0, 0]), le(sl2), body2, le(sl2)]));
  for (const f of frames) {
    const bb = Buffer.concat([Buffer.alloc(20), f, Buffer.alloc(4)]);
    const e = 4 + 4 + bb.length + 4;
    parts.push(Buffer.concat([Buffer.from([6, 0, 0, 0]), le(e), bb, le(e)]));
  }
  return Buffer.concat(parts);
}
