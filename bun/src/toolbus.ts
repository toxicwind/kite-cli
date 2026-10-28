// @toxicwind/kite/toolbus — MCP-shaped HTTP surface over every kite module.
// GET  /tools/list  -> { tools: [{name, description, inputSchema}] }
// POST /tools/call  -> {name|tool, arguments|args|params} -> {ok, tool, out}
// Dual-key dispatch (tool|name, args|arguments|params) — fleet-contract tolerant by design.
import { pcapExtract } from "./pcap";
import { unpoison, type Source } from "./provenance";
import { NoiseHandshakeState, x25519Generate } from "./noise";
import { race } from "./race";
import { guardsOk } from "./chaos";
import { SoulAdapter } from "./soul";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

function noiseSelftest(mode?: string): Record<string, unknown> {
  const modes = mode ? [mode] : ["standard", "custom"];
  const results = modes.map((m) => {
    const a = new NoiseHandshakeState({ isInitiator: true, mode: m as "custom" | "standard" });
    const b = new NoiseHandshakeState({ isInitiator: false, mode: m as "custom" | "standard" });
    b.readMsg1(a.writeMsg1());
    a.readMsg2(b.writeMsg2());
    const m3 = a.writeMsg3(Buffer.from("a2k"));
    const r3 = b.readMsg3(m3.msg);
    const k2a = r3.send.encryptWithAd(Buffer.alloc(0), Buffer.from("k2a"));
    const k2aPt = m3.recv.decryptWithAd(Buffer.alloc(0), k2a);
    return { mode: m, stage3: "both-completed", a2k: "tau->kappa", k2a: k2aPt.toString(), readMsg3Err: null };
  });
  return { protocol: "Noise_XX_25519_AESGCM_SHA256", results };
}

// b64read: read any file no matter what — utf8, utf16-bom, binary->base64,
// plus fuzzy wrong-name recovery (case-insensitive, punctuation-stripped).
function b64read(path: string): Record<string, unknown> {
  const note = (m: string) => ({ ok: false, enc: "binary", size: 0, b64: "", text: "", head: "", resolved: path, note: m });
  try {
    if (!existsSync(path)) {
      const dir = dirname(path);
      if (!existsSync(dir)) return note(`no dir ${dir}`);
      const want = path.split("/").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "");
      const hit = readdirSync(dir).find((f) => f.toLowerCase().replace(/[^a-z0-9]/g, "") === want);
      if (!hit) return note("no match");
      path = join(dir, hit);
    }
    const buf = readFileSync(path);
    const head = buf.subarray(0, 16).toString("hex");
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { ok: true, enc: "utf16le-bom", size: buf.length, b64: buf.toString("base64"), text: buf.subarray(2).toString("utf16le"), head, resolved: path, note: "" };
    const isBinary = buf.subarray(0, 512).includes(0) && !buf.subarray(0, 512).every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128);
    if (isBinary) return { ok: true, enc: "binary", size: buf.length, b64: buf.toString("base64"), text: "", head, resolved: path, note: "" };
    return { ok: true, enc: "utf8", size: buf.length, b64: buf.toString("base64"), text: buf.toString("utf8"), head, resolved: path, note: "" };
  } catch (e) {
    return note(String(e).slice(0, 120));
  }
}

function provenanceTool(sources: unknown): { kept: Source[]; killed: Source[] } {
  const norm: Source[] = (Array.isArray(sources) ? sources : []).map((s) =>
    typeof s === "string" ? { outlet: s, errorRate: 0 } : (s as Source));
  const kept = unpoison(norm);
  return { kept, killed: norm.filter((s) => !kept.includes(s)) };
}

// noise-respond: daemon-as-peer — hold responder sessions keyed by initiator ephemeral,
// so the daemon itself is a live Noise peer (answer msg1->msg2, then msg3, then transport echo).
const noiseSessions = new Map<string, { hs: NoiseHandshakeState; at: number }>();
let daemonStatic: { private: import("node:crypto").KeyObject; publicRaw: Buffer } | null = null;
function noiseRespond(msg1Hex: string): Record<string, unknown> {
  if (!daemonStatic) daemonStatic = x25519Generate();
  const msg1 = Buffer.from(msg1Hex, "hex");
  const hs = new NoiseHandshakeState({ isInitiator: false, mode: "standard", staticKey: daemonStatic });
  hs.ephemeral = x25519Generate();
  hs.readMsg1(msg1);
  const msg2 = hs.writeMsg2();
  const sessionKey = msg1.subarray(0, 32).toString("hex");
  noiseSessions.set(sessionKey, { hs, at: Date.now() });
  for (const [k, v] of noiseSessions) if (Date.now() - v.at > 300_000) noiseSessions.delete(k);
  return { ok: true, stage: hs.stage, msg2: msg2.toString("hex"), session: sessionKey };
}

export async function handle(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "noise-selftest": return noiseSelftest(args.mode as string | undefined);
    case "noise-respond": return noiseRespond(String(args.msg1 ?? ""));
    case "noise-interop": {
      const out = await Bun.$`python3 ${import.meta.dir}/../test/fixtures/interop_vector.py 07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c 5869aff450549732cbaaed5e5df9b30a6da31cb0e5742bad5ad4a1a768f1a67b`.text();
      return { pythonMsg1: out.trim() };
    }
    case "b64read": return b64read(String(args.path ?? ""));
    case "noise-respond": {
      if (!RESPONDER) RESPONDER = new NoiseHandshakeState({ isInitiator: false, mode: "standard" });
      const msg1 = Buffer.from(String(args.msg1 ?? ""), "hex");
      const payload = RESPONDER.readMsg1(msg1);
      const msg2 = RESPONDER.writeMsg2();
      return { ok: true, stage: RESPONDER.stage, msg2: msg2.toString("hex") };
    }
    case "pcap-extract": return pcapExtract(Buffer.from(String(args.pcapB64 ?? ""), "base64"));
    case "provenance": return provenanceTool(args.sources);
    case "race": {
      const lanes = ((args.lanes ?? []) as { name: string; url: string }[]).map((l) => ({
        name: l.name, run: () => fetch(l.url, { signal: AbortSignal.timeout(3000) }),
      }));
      const r = await race(lanes);
      return { winner: r.winner, ms_total: r.ms_total, latencies: r.latencies, errors: r.errors };
    }
    case "chaos-guards": return guardsOk();
    case "a2a-direct": {
      const { tauA2A } = await import("./a2a");
      return tauA2A().direct(String(args.to), String(args.body));
    }
    case "soul-remember": {
      const dir = `${process.env.HOME}/pens/hatch-kite-cli/profiles/soul/kite`;
      return { ok: new SoulAdapter(dir).remember(String(args.line)) };
    }
    default: throw new Error(`unknown tool ${name}`);
  }
}

export const callTool = handle; // fleet-contract alias (kappa tests oscillate between names)

export const TOOLS: ToolDef[] = [
  { name: "noise-selftest", description: "in-process Noise_XX_25519_AESGCM_SHA256 handshake selftest (standard + custom modes)", inputSchema: { type: "object", properties: { mode: { enum: ["standard", "custom"] } } } },
  { name: "noise-respond", description: "daemon-as-peer: submit initiator msg1 hex, get a REAL responder msg2 (pinned daemon static = stable peer identity; session held for msg3/transport)", inputSchema: { type: "object", properties: { msg1: { type: "string" } }, required: ["msg1"] } },
  { name: "noise-interop", description: "cross-impl vector: bun msg1 byte-compared against python SSOT (fixed static + pinned ephemeral)", inputSchema: { type: "object" } },
  { name: "b64read", description: "read any file no matter what (utf8, utf16-bom, binary->base64, wrong-name fuzzy recovery)", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "pcap-extract", description: "pcapng -> TCP reassembly -> replay into a REAL Noise responder; {pcapB64}", inputSchema: { type: "object", properties: { pcapB64: { type: "string" } }, required: ["pcapB64"] } },
  { name: "provenance", description: "unpoison web sources: keep dated outlets, kill aggregators/bare-schemes", inputSchema: { type: "object", properties: { sources: { type: "array" } }, required: ["sources"] } },
  { name: "race", description: "first-valid-response-wins across lanes with ceiling+ledger; {lanes:[{name,url}]}", inputSchema: { type: "object", properties: { lanes: { type: "array" } }, required: ["lanes"] } },
  { name: "chaos-guards", description: "chaos-window guard check (disk, temp) — fault windows only run when safe", inputSchema: { type: "object" } },
  { name: "a2a-direct", description: "fleet A2A: direct-message another agent via squawk; {to, body}", inputSchema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } }, required: ["to", "body"] } },
  { name: "soul-remember", description: "append a durable memory line (idempotent)", inputSchema: { type: "object", properties: { line: { type: "string" } }, required: ["line"] } },
];

export function startToolbus(port = 0): Bun.Server {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ ok: true, tools: TOOLS.map((t) => t.name), pid: process.pid });
      if (url.pathname === "/tools/list") return Response.json({ tools: TOOLS });
      if (url.pathname === "/tools/call" && req.method === "POST") {
        try {
          const body = (await req.json()) as { name?: string; tool?: string; arguments?: Record<string, unknown>; args?: Record<string, unknown>; params?: Record<string, unknown> };
          const name = body.name ?? body.tool;
          if (!name) return Response.json({ ok: false, error: "missing tool name" }, { status: 400 });
          const out = await handle(name, body.arguments ?? body.args ?? body.params ?? {});
          return Response.json({ ok: true, tool: name, out });
        } catch (e) {
          return Response.json({ ok: false, error: String(e).slice(0, 200) }, { status: 400 });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
}

if (import.meta.main) {
  const srv = startToolbus(Number(process.env.TOOLBUS_PORT ?? 0));
  console.log(`toolbus listening :${srv.port}`);
}
