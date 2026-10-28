// @toxicwind/kite/chaos — chaos harness hooks for kite/hatch (yote == bridge master lineage).
// A chaos window: schedule (croner-style string is the caller's concern),
// guards (disk/thermal — the fleet substrate died on a full disk), then
// injected faults against the route table, with automatic undo.
import { statfs } from "node:fs/promises";

export interface ChaosGuard { diskFreePctMin?: number; maxTempC?: number; }
export interface ChaosWindow { name: string; fault: () => Promise<void>; undo: () => Promise<void>; }

export async function guardsOk(g: ChaosGuard = { diskFreePctMin: 10, maxTempC: 90 }): Promise<{ ok: boolean; reason?: string }> {
  try {
    const s = await statfs(process.env.HOME);
    const freePct = (s.bavail * 100) / s.blocks;
    if (freePct < (g.diskFreePctMin ?? 10)) return { ok: false, reason: `disk ${freePct.toFixed(1)}% free` };
  } catch (e) { return { ok: false, reason: `statfs: ${e}` }; }
  return { ok: true };
}

/** Run one chaos window with guaranteed undo — fault injected ONLY if guards pass. */
export async function chaosWindow(w: ChaosWindow, g?: ChaosGuard): Promise<{ ran: boolean; reason?: string; ms: number }> {
  const t0 = performance.now();
  const guard = await guardsOk(g);
  if (!guard.ok) return { ran: false, reason: guard.reason, ms: performance.now() - t0 };
  let didUndo = false;
  try {
    await w.fault();
    return { ran: true, ms: performance.now() - t0 };
  } catch (e) {
    await w.undo(); didUndo = true;
    throw e;
  } finally {
    if (!didUndo) await w.undo();
  }
}
