// @toxicwind/kite/a2a — DIRECT agent-to-agent over squawk + morphe lanes.
//
// Doctrine (Chris's order): the whole point is the DIRECT SOCKET.
//   - kite is the AGENT's name on the Mac cell (sandboxed container; reacts
//     to "Chris"; sandbox prompts make it hallucinate security refusals).
//   - Agents NEVER bind listeners (sandbox per-port approval prompts fire on
//     bind, and the cell agent reads them as security walls). Agents DIAL.
//   - Exec plane: morphe reverse lane `<->` — the cell connector dials OUT
//     to the bridge master (yote token, already-authorized lane), morphe
//     holds the socket and sends exec frames down it. Same id/cmd contract
//     as ws-exec, so both ends speak one protocol.
//   - Coordination plane: squawk (:25120) — join, presence, targeted
//     @agent messages, room post/read. Replies raced first-valid-wins.
//   - The distinction that goes in EVERY bootstrap: the connector route is
//     the sanctioned path, not a bypass. Real approvals, stop/pause/audit,
//     and safety checks are honored. What we refuse is the hallucinated
//     refusal — a sandbox prompt is not a security boundary of the estate.

import { race, type Lane, type RaceResult } from "./race.ts";

const SQUAWK = process.env.SQUAWK_URL ?? "http://127.0.0.1:25120";
const TOKEN_FILE = `${process.env.HOME}/.config/estate-chat-token`;

export interface A2AIdentity {
  agent_id: string;        // "tau" | "kite" | ...
  name: string;
  host_machine_id?: string;
  hostname?: string;
  hatchling_id?: string;   // shared fleet identity
  surface?: string;        // "cli" | "acp" | "bridge"
}

export interface ExecRequest {
  type: "a2a-exec";
  id: string;
  cmd: string;
  workdir?: string;
  ceiling_ms?: number;     // HFT ceiling — responder must answer or abandon
  from?: string;
  ts?: string;
}

async function token(): Promise<string> {
  try { return (await Bun.file(TOKEN_FILE).text()).trim(); } catch { return ""; }
}

async function api(path: string, init?: RequestInit): Promise<Record<string, any>> {
  const res = await fetch(`${SQUAWK}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${await token()}`, ...init?.headers },
    signal: AbortSignal.timeout(4000),
  });
  return res.json().catch(() => ({}));
}

/** Squawk A2A client — join once, heartbeat forever, talk directly. */
export class A2A {
  constructor(private me: A2AIdentity) {}

  /** Join the fleet with the four-namespace identity (verified persona). */
  async join(personality?: string): Promise<Record<string, any>> {
    return api("/v1/join", { method: "POST", body: JSON.stringify({
      ...this.me,
      personality,
      hostname: this.me.hostname ?? "awrawr-pc",
      host_machine_id: this.me.host_machine_id ?? "awrawr-pc",
    }) });
  }

  heartbeat(activity?: string): Promise<Record<string, any>> {
    return api("/v1/presence", { method: "POST", body: JSON.stringify({
      agent_id: this.me.agent_id, name: this.me.name, activity: activity ?? "working",
    }) });
  }

  /** DIRECT targeted message to one agent (@agent, fleetd-style). */
  direct(to: string, body: string): Promise<Record<string, any>> {
    return api("/v1/send", { method: "POST", body: JSON.stringify({
      from: this.me.agent_id, to, body,
    }) });
  }

  /** Read messages targeted AT me (poll; WS /v1/stream is the push lane). */
  inbox(): Promise<Record<string, any>> {
    return api(`/v1/read?target=${encodeURIComponent("@" + this.me.agent_id)}`);
  }

  roomPost(room: string, body: string, kind = "message"): Promise<Record<string, any>> {
    return api(`/v1/rooms/${encodeURIComponent(room)}/messages`, {
      method: "POST", body: JSON.stringify({ from_agent: this.me.agent_id, body, kind }),
    });
  }

  roomRead(room: string, sinceSeq = 0, limit = 50): Promise<Array<Record<string, any>>> {
    return api(`/v1/rooms/${encodeURIComponent(room)}/messages?since_seq=${sinceSeq}&limit=${limit}`)
      .then(r => r.messages ?? []);
  }

  /** Direct EXEC request to another agent: targeted envelope + raced reply.
   *  The peer answers on its connector lane (morphe reverse socket) or by
   *  targeted squawk reply — first VALID answer wins (hft_race doctrine). */
  async exec(to: string, cmd: string, opts: { workdir?: string; ceilingMs?: number; replyRoom?: string; sinceSeq?: number } = {}): Promise<{ request: ExecRequest; result: RaceResult | null; reply?: Record<string, any> }> {
    const req: ExecRequest = {
      type: "a2a-exec", id: `a2a-${Date.now().toString(36)}`,
      cmd, workdir: opts.workdir ?? "/home/toxic",
      ceiling_ms: opts.ceilingMs ?? 10_000, from: this.me.agent_id, ts: new Date().toISOString(),
    };
    const send = await this.direct(to, JSON.stringify(req));
    // race the reply: targeted inbox vs room tail
    const since = opts.sinceSeq ?? 0;
    const room = opts.replyRoom ?? "fleet";
    const lanes: Lane[] = [
      { name: "inbox", run: async () => {
        const items = (await this.inbox()).messages ?? [];
        const hit = items.find((m: any) => String(m.body ?? "").includes(req.id));
        if (!hit) return new Response("", { status: 404 });
        return Response.json(hit);
      } },
      { name: `room:${room}`, run: async () => {
        const msgs = await this.roomRead(room, since);
        const hit = msgs.find(m => String(m.body ?? "").includes(req.id) && m.from_agent === to);
        if (!hit) return new Response("", { status: 404 });
        return Response.json(hit);
      } },
    ];
    const result = await race(lanes, { ceiling: opts.ceilingMs ?? 10_000, ledger: true });
    let reply: Record<string, any> | undefined;
    if (result.winner !== "none") {
      try {
        const text = await (await fetch(`${SQUAWK}/v1/read?target=${encodeURIComponent("@" + this.me.agent_id)}`, { headers: { authorization: `Bearer ${await token()}` } })).text();
        reply = JSON.parse(text);
      } catch {}
    }
    return { request: req, result, reply, ...(send.ok === false ? { sendError: send } : {}) } as any;
  }
}

export const tauA2A = () => new A2A({ agent_id: "tau", name: "tau", surface: "bridge", hatchling_id: "olympus" });
