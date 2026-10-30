// HFT lane racing — first-valid-wins, winner ledger (hft_race.py doctrine).
// CEILING: a lane that hasn't answered validly within ceiling is abandoned;
// the winner is the FIRST lane with a REAL (non-handshake) response.
// Ledger: ~/.cache/kite/race-winners.jsonl — one JSON line per race.

import { mkdirSync } from "node:fs";

export const CEILING = Number(process.env.RACE_CEILING ?? 2000);
export const FLOOR = Number(process.env.RACE_FLOOR ?? "3");

export interface Lane { name: string; run: () => Promise<Response>; }
export interface RaceResult {
  winner: string;
  latencies: Record<string, number>;
  errors: Record<string, string>;
  ms_total: number;
}

function ledgerPath(): string {
  const dir = `${process.env.HOME}/.cache/kite`;
  mkdirSync(dir, { recursive: true });
  return `${dir}/race-winners.jsonl`;
}

export async function race(lanes: Lane[], opts: { ceiling?: number; ledger?: boolean } = {}): Promise<RaceResult> {
  const ceiling = opts.ceiling ?? CEILING;
  const t0 = performance.now();
  const latencies: Record<string, number> = {};
  const errors: Record<string, string> = {};

  const attempt = async (lane: Lane) => {
    const s = performance.now();
    try {
      const res = await Promise.race([
        lane.run(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("ceiling")), ceiling)),
      ]);
      const ms = performance.now() - s;
      latencies[lane.name] = ms;
      if (res.status < 400) return { lane: lane.name, ms };
      errors[lane.name] = `http ${res.status}`;
    } catch (e) {
      errors[lane.name] = String(e).slice(0, 120);
      latencies[lane.name] = performance.now() - s;
    }
    return null;
  };

  // first-valid-wins: everyone fires; first non-null completion wins;
  // losers are NOT cancelled mid-flight (responses are consumed/abandoned).
  const winner = await Promise.any(lanes.map(attempt));
  const result: RaceResult = {
    winner: winner?.lane ?? "none",
    latencies,
    errors,
    ms_total: performance.now() - t0,
  };
  if (opts.ledger !== false) {
    const sink = Bun.file(ledgerPath()).writer({ highWaterMark: 1024 });
    sink.write(JSON.stringify({ ts: new Date().toISOString(), ...result }) + "\n");
    await sink.end();
  }
  return result;
}

/** P50/P95/P99 per lane over N races (bench mode). */
export async function bench(lanesFn: () => Lane[], n = 20): Promise<Record<string, { p50: number; p95: number; p99: number }>> {
  const perLane: Record<string, number[]> = {};
  for (let i = 0; i < n; i++) {
    const r = await race(lanesFn(), { ledger: false });
    for (const [lane, ms] of Object.entries(r.latencies)) {
      (perLane[lane] ??= []).push(ms);
    }
    await Bun.sleep(FLOOR);
  }
  const pct = (xs: number[], p: number) => xs.sort((a, b) => a - b)[Math.floor(xs.length * p)] ?? 0;
  return Object.fromEntries(Object.entries(perLane).map(([lane, xs]) =>
    [lane, { p50: Math.round(pct(xs, .5)), p95: Math.round(pct(xs, .95)), p99: Math.round(pct(xs, .99)) }]));
}
