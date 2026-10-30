import { strictEqual, ok } from "node:assert";
import { parsePcapng, epbPackets, extractTCPPayloads, reassembleStream, replayNoiseMsg1, pcapExtract } from "../src/pcap.ts";
import { NoiseHandshakeState } from "../src/noise.ts";

function ethFrame(src: Buffer, dst: Buffer, ethertype: number, payload: Buffer): Buffer {
  return Buffer.concat([dst, src, Buffer.from([ethertype >> 8, ethertype & 0xff]), payload]);
}
function ipv4Packet(totalLen: number, proto: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(20);
  header[0] = 0x45; header[1] = 0;
  header.writeUInt16BE(totalLen, 2); header.writeUInt16BE(0x0001, 4);
  header.writeUInt16BE(0x4000, 6); header[8] = 64; header[9] = proto;
  header[12] = 10; header[13] = 0; header[14] = 0; header[15] = 1;
  header[16] = 10; header[17] = 0; header[18] = 0; header[19] = 2;
  return Buffer.concat([header, payload]);
}
function tcpSegment(sport: number, dport: number, seq: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(sport, 0); header.writeUInt16BE(dport, 2);
  header.writeUInt32BE(seq, 4); header[12] = 5 << 4; header[13] = 0x10;
  header.writeUInt16BE(8192, 14); header.writeUInt16BE(0, 16); header.writeUInt16BE(0, 18);
  return Buffer.concat([header, payload]);
}
function blockBody(capLen: number, packet: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0,0,0,0]), Buffer.from([0,0,0,0]), Buffer.from([0,0,0,0]),
    Buffer.from([capLen & 0xff, (capLen >> 8) & 0xff, (capLen >> 16) & 0xff, capLen >> 24]),
    Buffer.from([packet.length & 0xff, (packet.length >> 8) & 0xff, (packet.length >> 16) & 0xff, packet.length >> 24]),
    packet, Buffer.from([0,0,0,0]),
  ]);
}
function epbBlock(packet: Buffer): Buffer {
  const body = blockBody(packet.length, packet);
  const sectionLen = 4 + 4 + body.length + 4;
  return Buffer.concat([Buffer.from([6, 0, 0, 0]), Buffer.from([sectionLen & 0xff, (sectionLen >> 8) & 0xff, (sectionLen >> 16) & 0xff, sectionLen >> 24]), body, Buffer.from([sectionLen & 0xff, (sectionLen >> 8) & 0xff, (sectionLen >> 16) & 0xff, sectionLen >> 24])]);
}
function makePcapng(frames: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  const shbBody = Buffer.concat([Buffer.from([1, 0]), Buffer.from([0x99, 0x99, 0x99, 0x99]), Buffer.from("test-capture\0"), Buffer.from([0, 0])]);
  const shbLen = 4 + 4 + shbBody.length + 4;
  parts.push(Buffer.concat([Buffer.from([0xa, 0, 0, 0]), Buffer.from([shbLen & 0xff, (shbLen >> 8) & 0xff, (shbLen >> 16) & 0xff, shbLen >> 24]), shbBody, Buffer.from([shbLen & 0xff, (shbLen >> 8) & 0xff, (shbLen >> 16) & 0xff, shbLen >> 24])]));
  const idbBody = Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from([0, 0]), Buffer.from([1, 0]), Buffer.from([0, 0]), Buffer.from([0, 0])]);
  const idbLen = 4 + 4 + idbBody.length + 4;
  parts.push(Buffer.concat([Buffer.from([0x1, 0, 0, 0]), Buffer.from([idbLen & 0xff, (idbLen >> 8) & 0xff, (idbLen >> 16) & 0xff, idbLen >> 24]), idbBody, Buffer.from([idbLen & 0xff, (idbLen >> 8) & 0xff, (idbLen >> 16) & 0xff, idbLen >> 24])]));
  for (const f of frames) parts.push(epbBlock(f));
  return Buffer.concat(parts);
}

test("kite pcap: parsePcapng recovers SHB + IDB + EPB", () => {
  const alice = new NoiseHandshakeState({ isInitiator: true, mode: "standard" });
  const msg1 = alice.writeMsg1();
  const eth = ethFrame(Buffer.from([1,2,3,4,5,6]), Buffer.from([6,5,4,3,2,1]), 0x0800,
    ipv4Packet(20 + 20 + msg1.length, 6, tcpSegment(40000, 443, 1000, msg1)));
  const blocks = parsePcapng(makePcapng([eth]));
  strictEqual(blocks.length, 3);
  const epb = blocks.find(b => b.type === 6)!;
  strictEqual(epbPackets(epb).length, 1);
});

test("kite pcap: extract→replay round-trip advances a REAL responder handshake", () => {
  const alice = new NoiseHandshakeState({ isInitiator: true, mode: "standard" });
  const msg1 = alice.writeMsg1();
  const eth = ethFrame(Buffer.from([1,2,3,4,5,6]), Buffer.from([6,5,4,3,2,1]), 0x0800,
    ipv4Packet(20 + 20 + msg1.length, 6, tcpSegment(40000, 443, 1000, msg1)));
  const out = pcapExtract(makePcapng([eth]));
  ok(out.replay.ok);
  strictEqual(out.replay.stage, 1);
  strictEqual(out.replay.payloadLen, msg1.length);
  strictEqual(out.replay.remoteEphemeral?.length, 64);  // msg2 ephemeral
  strictEqual(out.flows?.length, 1);
});

test("kite pcap: two split frames reassemble in seq order", () => {
  const alice = new NoiseHandshakeState({ isInitiator: true, mode: "standard" });
  const msg1 = alice.writeMsg1();
  const half = Math.floor(msg1.length / 2);
  const a = ethFrame(Buffer.from([1,2,3,4,5,6]), Buffer.from([6,5,4,3,2,1]), 0x0800,
    ipv4Packet(20 + 20 + half, 6, tcpSegment(40000, 443, 1000, msg1.subarray(0, half))));
  const b = ethFrame(Buffer.from([1,2,3,4,5,6]), Buffer.from([6,5,4,3,2,1]), 0x0800,
    ipv4Packet(20 + 20 + (msg1.length - half), 6, tcpSegment(40000, 443, 1000 + half, msg1.subarray(half))));
  const out = pcapExtract(makePcapng([b, a]));
  ok(out.replay.ok);
  strictEqual(out.replay.payloadLen, msg1.length);
  strictEqual(out.flows?.length, 1);
});

test("kite pcap: non-pcapng input is honest", () => {
  const out = pcapExtract(Buffer.from("not pcapng at all"));
  strictEqual(out.blocks, 0);
  strictEqual(out.replay.ok, false);
  strictEqual(out.replay.reason, "no tcp flow");
  strictEqual(out.flows, undefined);
});
