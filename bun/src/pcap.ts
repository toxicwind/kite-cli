// pcap-bridge-extractor (tau impl of kappa's test-first spec, 2026-10-28).
// pcapng length-driven parser (CRC skipped by design) -> TCP flow reassembly (seq-aware)
// -> replay into a REAL Noise_XX responder (bridge: capture bytes advance a live handshake).
import { NoiseHandshakeState } from "./noise";

export type PcapngBlock = { type: number; body: Buffer };
export function parsePcapng(buf: Buffer): PcapngBlock[] {
  const blocks: PcapngBlock[] = [];
  let off = 0;
  while (off + 12 <= buf.length) {
    const type = buf.readUInt32LE(off);
    const total = buf.readUInt32LE(off + 4);
    if (total < 12 || off + total > buf.length) break;
    blocks.push({ type, body: buf.subarray(off + 8, off + total - 4) });
    off += total;
  }
  return blocks;
}
export function idbLinktype(idb: PcapngBlock): number {
  return idb.body.readUInt16LE(0);
}
export function epbPackets(epb: PcapngBlock): Buffer[] {
  const capLen = epb.body.readUInt32LE(12);
  return [epb.body.subarray(20, 20 + capLen)];
}
export type TcpSegment = { src: string; dst: string; sport: number; dport: number; seq: number; payload: Buffer };
export function extractTCPPayloads(packets: Buffer[]): TcpSegment[] {
  const segs: TcpSegment[] = [];
  for (const pkt of packets) {
    if (pkt.length < 34 || pkt.readUInt16BE(12) !== 0x0800) continue;
    const ihl = (pkt[14] & 0x0f) * 4;
    if (pkt[14 + 9] !== 6) continue;
    const t = 14 + ihl;
    if (pkt.length < t + 20) continue;
    segs.push({
      src: pkt.subarray(26, 30).join("."), dst: pkt.subarray(30, 34).join("."),
      sport: pkt.readUInt16BE(t), dport: pkt.readUInt16BE(t + 2),
      seq: pkt.readUInt32BE(t + 4),
      payload: pkt.subarray(t + (pkt[t + 12] >> 4) * 4),
    });
  }
  return segs;
}
export function reassembleStream(segs: TcpSegment[]): Buffer {
  const withData = segs.filter(s => s.payload.length > 0).sort((a, b) => a.seq - b.seq || a.sport - b.sport);
  return Buffer.concat(withData.map(s => s.payload));
}
export type NoiseReplay = { ok: boolean; stage?: number; payloadLen?: number; remoteEphemeral?: Buffer; reason?: string };
export function replayNoiseMsg1(stream: Buffer): NoiseReplay {
  if (!stream.length) return { ok: false, reason: "no tcp flow" };
  try {
    const resp = new NoiseHandshakeState({ isInitiator: false, mode: "standard" });
    resp.readMsg1(stream);                      // capture bytes advance a REAL handshake
    const stage = resp.stage;                   // snapshot post-msg1 (1)
    const msg2 = resp.writeMsg2();              // elicit the real reply — proof of bridge
    return { ok: true, stage, payloadLen: stream.length, remoteEphemeral: msg2.subarray(0, 64) };
  } catch (e) {
    return { ok: false, reason: String(e).slice(0, 120) };
  }
}
export function pcapExtract(buf: Buffer): { blocks: number; replay: NoiseReplay; flows?: string[] } {
  const blocks = parsePcapng(buf);
  if (!blocks.length) return { blocks: 0, replay: { ok: false, reason: "no tcp flow" } };
  const packets = blocks.filter(b => b.type === 6).flatMap(epbPackets);
  const segs = extractTCPPayloads(packets);
  if (!segs.length) return { blocks: blocks.length, replay: { ok: false, reason: "no tcp flow" } };
  const flows = [...new Set(segs.map(s => `${s.src}:${s.sport}->${s.dst}:${s.dport}`))];
  return { blocks: blocks.length, replay: replayNoiseMsg1(reassembleStream(segs)), flows };
}
