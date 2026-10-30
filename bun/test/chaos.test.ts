import { strictEqual, ok } from "node:assert";
import { chaosWindow, guardsOk } from "../src/chaos.ts";

test("chaos: guardsOk passes on this box", async () => {
  const g = await guardsOk({ diskFreePctMin: 1, maxTempC: 1000 });
  strictEqual(g.ok, true);
});

test("chaos: guard-blocked window never faults, never undoes", () => {
  let faulted = 0; let undone = 0;
  return chaosWindow({
    name: "blocked",
    fault: async () => { faulted++; },
    undo: async () => { undone++; },
  }, { diskFreePctMin: 999 }).then((r) => {
    strictEqual(r.ran, false);
    ok(r.reason.includes("disk"));
    strictEqual(faulted, 0);
    strictEqual(undone, 0);
  });
});

test("chaos: fault then undo always", async () => {
  let faulted = 0; let undone = 0;
  const r = await chaosWindow({
    name: "ok",
    fault: async () => { faulted++; },
    undo: async () => { undone++; },
  });
  strictEqual(r.ran, true);
  strictEqual(faulted, 1);
  strictEqual(undone, 1);
  strictEqual(r.ms >= 0, true);
});

test("chaos: fault throw still undoes", async () => {
  let faulted = 0; let undone = 0;
  await chaosWindow({
    name: "boom",
    fault: async () => { faulted++; throw new Error("boom"); },
    undo: async () => { undone++; },
  }).then(() => { throw new Error("should have rejected"); })
    .catch(() => {});
  strictEqual(faulted, 1);
  strictEqual(undone, 1);
});
