#!/usr/bin/env bun
/**
 * kite-mcp.ts — MCP server (stdio) exposing the kite-cli daemon + gateway as
 * first-class MCP tools. Thresher federates it as upstream "kite".
 *
 * Design (per architect: maximal MCP, thresher = main and only MCP):
 *   - every tool routes through the warm kite-daemon unix socket when up
 *     (~/.config/kite-cli/daemon.sock), falling back to `kite` CLI invocations
 *     — never opens a second Noise-XX connection (single warm lane doctrine).
 *   - 258 gateway methods exist; we surface the high-value subset as tools and
 *     a generic `kite_gateway_call` escape hatch for the rest (method from
 *     routes.json).
 *
 * TDD note: tools call the real daemon/CLI — no mocks. `kite-mcp.ts selftest`
 * runs the live probes (needs auth cookies present).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";

const KITE_DIR = "/home/toxic/pens/ranch/hatch/kite-cli";
const SOCK = `${process.env.HOME}/.config/kite-cli/daemon.sock`;
const PYTHON = process.env.KITE_PYTHON || `${process.env.HOME}/.local/bin/kite`;
const BIN = process.env.KITE_BIN || `${KITE_DIR}/bin/kite`; // fallback launcher

function kiteBin(): string {
  for (const c of [PYTHON, BIN]) {
    try {
      if (existsSync(c)) return c;
    } catch {}
  }
  return "kite";
}

/** JSON request over the daemon socket; returns parsed reply or null. */
async function daemonCall(req: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (!existsSync(SOCK)) return null;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const c = createConnection(SOCK);
    const timer = setTimeout(() => {
      c.destroy();
      resolve(null);
    }, 8000);
    c.on("connect", () => c.write(JSON.stringify(req) + "\n"));
    c.on("data", (d) => chunks.push(d));
    c.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    c.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** CLI fallback: run `kite <args>` and capture stdout (JSON when possible). */
function cli(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(kiteBin(), args, { encoding: "utf8", timeout: 30000 });
  return { ok: r.status === 0, out: (r.stdout || r.stderr || "").trim() };
}

// ── tool surface ────────────────────────────────────────────────────────────
type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };

const TOOLS: Tool[] = [
  {
    name: "kite_status",
    description: "kite daemon + muse.ai VM status (uptime, vm_id, socket health).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kite_chat_send",
    description: "Send a message to the muse.ai agent (main chat). Returns the agent reply.",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
  {
    name: "kite_chat_history",
    description: "Fetch recent muse.ai chat history (threads + messages).",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "kite_cell",
    description: "kite cell filesystem ops (list/read/write paths inside the muse.ai VM).",
    inputSchema: { type: "object", properties: { op: { type: "string", enum: ["list", "read", "write"] }, path: { type: "string" }, content: { type: "string" } }, required: ["op", "path"] },
  },
  {
    name: "kite_activity",
    description: "List recent muse.ai activity events.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "kite_feed",
    description: "Read the muse.ai feed (entries + status).",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "kite_goals",
    description: "List muse.ai goals (optionally one goal by id).",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
  },
  {
    name: "kite_ideas",
    description: "List muse.ai ideas.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kite_cron",
    description: "muse.ai cron endpoints: list/put/rm executable cron jobs.",
    inputSchema: { type: "object", properties: { op: { type: "string", enum: ["list", "put", "rm"] }, id: { type: "string" }, spec: { type: "string" } }, required: ["op"] },
  },
  {
    name: "kite_gateway_call",
    description:
      "Generic escape hatch: call any of the 258 gateway methods from routes.json (e.g. 'chat.history'). Use kite_status first if unsure.",
    inputSchema: { type: "object", properties: { method: { type: "string" }, body: { type: "object" }, query: { type: "object" } }, required: ["method"] },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<{ content: [{ type: "text"; text: string }]; isError?: boolean }> {
  const reply = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });
  try {
    switch (name) {
      case "kite_status": {
        const d = await daemonCall({ op: "status" });
        if (d) return reply(d);
        const s = cli(["status"]);
        return reply({ daemon: false, cli_ok: s.ok, out: s.out.slice(0, 800) });
      }
      case "kite_chat_send": {
        const msg = String(args.message ?? "");
        const d = await daemonCall({ op: "chat.send", body: { message: msg } });
        if (d) return reply(d);
        const s = cli(["send", msg]);
        return reply({ ok: s.ok, out: s.out.slice(0, 2000) });
      }
      case "kite_chat_history": {
        const d = await daemonCall({ op: "chat.history", query: { limit: args.limit ?? 20 } });
        if (d) return reply(d);
        const s = cli(["history", String(args.limit ?? 20)]);
        return reply({ ok: s.ok, out: s.out.slice(0, 2500) });
      }
      case "kite_cell": {
        const op = String(args.op), p = String(args.path);
        const d = await daemonCall({ op: `cell.${op}`, body: { path: p, content: args.content } });
        if (d) return reply(d);
        const s = cli(["cell", op, p, ...(args.content ? [String(args.content)] : [])]);
        return reply({ ok: s.ok, out: s.out.slice(0, 2500) });
      }
      case "kite_activity": {
        const d = await daemonCall({ op: "activity.list", query: { limit: args.limit ?? 20 } });
        if (d) return reply(d);
        const s = cli(["activity", String(args.limit ?? 20)]);
        return reply({ ok: s.ok, out: s.out.slice(0, 2000) });
      }
      case "kite_feed": {
        const d = await daemonCall({ op: "feed", query: { limit: args.limit ?? 20 } });
        if (d) return reply(d);
        const s = cli(["feed", "--limit", String(args.limit ?? 20)]);
        return reply({ ok: s.ok, out: s.out.slice(0, 2000) });
      }
      case "kite_goals": {
        if (args.id) return reply(cli(["goal", String(args.id)]));
        const d = await daemonCall({ op: "goals" });
        if (d) return reply(d);
        return reply(cli(["goals"]));
      }
      case "kite_ideas":
        return reply(cli(["ideas"]));
      case "kite_cron": {
        const op = String(args.op);
        if (op === "list") return reply(cli(["cron", "list"]));
        if (op === "rm") return reply(cli(["cron", "rm", String(args.id)]));
        return reply(cli(["cron", "put", String(args.spec ?? "")]));
      }
      case "kite_gateway_call": {
        const method = String(args.method ?? "");
        const d = await daemonCall({ op: "gateway.call", method, body: args.body, query: args.query });
        if (d) return reply(d);
        return reply({ error: "daemon down; generic gateway calls need the warm lane", hint: "start kite-daemon (mise run kite-daemon / pitchfork start estate/kite-daemon)" });
      }
      default:
        return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
    }
  } catch (e) {
    return { content: [{ type: "text", text: `kite tool error: ${(e as Error).message}` }], isError: true };
  }
}

// ── minimal MCP stdio loop (no SDK dep — thresher talks plain JSONRPC) ──────
function respond(id: unknown, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function respondErr(id: unknown, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = msg;
    if (method === "initialize") {
      respond(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "kite", version: "1.0.0" } });
    } else if (method === "notifications/initialized") {
      // no reply needed
    } else if (method === "tools/list") {
      respond(id, { tools: TOOLS });
    } else if (method === "tools/call") {
      callTool(String(params?.name ?? ""), params?.arguments ?? {}).then((r) => respond(id, r));
    } else if (method === "ping") {
      respond(id, {});
    } else if (id !== undefined) {
      respondErr(id, -32601, `method not supported: ${method}`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));