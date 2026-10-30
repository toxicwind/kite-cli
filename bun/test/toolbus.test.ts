import { strictEqual, ok } from "node:assert";
import { TOOLS, callTool } from "../src/toolbus";
import { unpoison } from "../src/provenance";
import { NoiseHandshakeState } from "../src/noise";

let tbPort = 0;
let tbServer: any;

async function startToolbus() {
  tbServer = Bun.serve({
    port: 0,
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/tools/list") return Response.json({ tools: TOOLS });
      if (url.pathname === "/tools/call" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const name: string = body.tool ?? body.name ?? "";
        const args: any = body.args ?? body.arguments ?? body.params ?? {};
        const out = await callTool(name, args);
        return Response.json({ ok: true, tool: name, out });
      }
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    },
  });
  tbPort = (tbServer as any).port;
}

async function call(name: string, args: any = {}): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${tbPort}/tools/call`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: name, args }),
  });
  const j = await res.json();
  strictEqual(j.ok, true, JSON.stringify(j));
  return j.out;
}

test("toolbus: /tools/list exposes ≥8 tools", async () => {
  await startToolbus();
  strictEqual(TOOLS.length >= 8, true, "expected ≥8 tools, got " + TOOLS.length);
  const out = await call("b64read", { path: "/home/toxic/AGENTS.md" });
  ok(out.ok);
  ok(typeof out.text === "string" && out.text.length > 100);
  tbServer.stop();
});

test("toolbus: noise-respond daemon-as-peer", async () => {
  await startToolbus();
  const hs = new NoiseHandshakeState({ isInitiator: true, mode: "standard" });
  const msg1 = hs.writeMsg1();
  const out = await call("noise-respond", { msg1: msg1.toString("hex") });
  ok(out.ok);
  strictEqual(out.stage, 2); // responder completed writeMsg2
  const payload = hs.readMsg2(Buffer.from(out.msg2, "hex"));
  strictEqual(hs.stage, 2);
  strictEqual(payload.length, 0);            // empty payload on msg2
  const fin = hs.writeMsg3();                // initiator completes: standard msg3 = sEnc(48)+enc(empty)(16)
  strictEqual(fin.msg.length, 64);
  tbServer.stop();
});

test("toolbus: noise-selftest both modes complete", async () => {
  await startToolbus();
  const out = await call("noise-selftest", {});
  strictEqual(out.protocol, "Noise_XX_25519_AESGCM_SHA256");
  const modes = out.results.map((r: any) => r.mode);
  ok(modes.includes("standard") && modes.includes("custom"));
  for (const r of out.results) {
    ok(r.a2k === "tau->kappa" || r.a2k === null);
  }
  tbServer.stop();
});

test("toolbus: provenance gate keeps dated outlets", async () => {
  await startToolbus();
  const out = await call("provenance", { sources: ["dev.to Oct 14 2026", "apidog Oct 22 2026", "AdminRemix aggregator", "ao:// official"] });
  strictEqual(out.kept.length, 2);
  strictEqual(out.killed.length, 2);
  tbServer.stop();
});

test("toolbus: pcap-extract round-trips a synthetic capture", async () => {
  await startToolbus();
  const hs = new NoiseHandshakeState({ isInitiator: true, mode: "standard" });
  const msg1 = hs.writeMsg1();
  const pcap = makePcap(msg1);
  const out = await call("pcap-extract", { pcapB64: pcap.toString("base64") });
  ok(out.replay.ok);
  strictEqual(out.replay.payloadLen, msg1.length);
  tbServer.stop();
});

test("toolbus: race picks first-valid lane", async () => {
  await startToolbus();
  const echo1 = Bun.serve({ port: 0, fetch: () => new Response("lane-a") });
  const echo2 = Bun.serve({ port: 0, fetch: () => new Response("lane-b") });
  await new Promise((r) => setTimeout(r, 100));
  const out = await call("race", { lanes: [
    { name: "slow", url: `http://127.0.0.1:${(echo1 as any).port}` },
    { name: "fast", url: `http://127.0.0.1:${(echo2 as any).port}` },
  ]});
  ok(["slow", "fast"].includes(out.winner));
  ok(typeof out.ms_total === "number");
  ok(typeof out.latencies === "object");
  tbServer.stop();
  echo1.stop(); echo2.stop();
});

test("toolbus: chaos-guards reports disk", async () => {
  await startToolbus();
  const out = await call("chaos-guards", {});
  ok(typeof out.ok === "boolean");
  tbServer.stop();
});

test("toolbus: soul-remember idempotent", async () => {
  await startToolbus();
  const dir = `/tmp/toolbus-soul-${Date.now()}`;
  const s = (await import("../src/soul.ts")).SoulAdapter;
  const soul = new s(dir);
  const line = `tb-remember-${Date.now()}`;
  const a = await call("soul-remember", { line });
  strictEqual(a.ok, true);
  const b = await call("soul-remember", { line });
  strictEqual(b.ok, false);
  tbServer.stop();
});

function makePcap(msg1: Buffer): Buffer {
  const shbBody = Buffer.concat([Buffer.from([1,0]), Buffer.from([0x99,0x99,0x99,0x99]), Buffer.from("tb-test\0"), Buffer.from([0,0])]);
  const shbLen = 4+4+shbBody.length+4;
  const shb = Buffer.concat([Buffer.from([0x0a,0,0,0]), uint32LE(shbLen), shbBody, uint32LE(shbLen)]);
  const idbBody = Buffer.concat([Buffer.from([1,0,0,0]), Buffer.from([0,0]), Buffer.from([1,0]), Buffer.from([0,0]), Buffer.from([0,0])]);
  const idbLen = 4+4+idbBody.length+4;
  const idb = Buffer.concat([Buffer.from([0x01,0,0,0]), uint32LE(idbLen), idbBody, uint32LE(idbLen)]);
  const eth = Buffer.concat([Buffer.alloc(6), Buffer.alloc(6), Buffer.from([0x08,0x00])]);
  const ip = Buffer.alloc(20); ip[0]=0x45; ip[9]=6; ip.writeUInt16BE(20+20+msg1.length,2);
  ip[12]=10; ip[13]=0; ip[14]=0; ip[15]=1; ip[16]=10; ip[17]=0; ip[18]=0; ip[19]=2;
  const tcp = Buffer.alloc(20); tcp.writeUInt16BE(40000,0); tcp.writeUInt16BE(443,2); tcp.writeUInt32BE(1000,4); tcp[12]=0x50; tcp[13]=0x10; tcp.writeUInt16BE(8192,14);
  const frame = Buffer.concat([eth, ip, tcp, msg1]);
  const epbBody = Buffer.concat([Buffer.alloc(12), uint32LE(frame.length), uint32LE(frame.length), frame]);
  const epbLen = 4+4+epbBody.length+4;
  const epb = Buffer.concat([Buffer.from([0x06,0,0,0]), uint32LE(epbLen), epbBody, uint32LE(epbLen)]);
  return Buffer.concat([shb, idb, epb]);
}
function uint32LE(n: number): Buffer {
  const b = Buffer.alloc(4); b.writeUInt32LE(n); return b;
}
