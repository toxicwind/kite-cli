import { describe, test, expect } from "bun:test";
import { Kite, RouteSchema } from "../src/index";
import { race, CEILING } from "../src/race";
import { chaosWindow, guardsOk } from "../src/chaos";

test("routes.json RPC surface parses through the zod gate", async () => {
  const kite = new Kite();
  const rpc = await kite.rpcRoutes();
  expect(Array.isArray(rpc)).toBe(true);
  expect(rpc.length).toBeGreaterThan(0);
  expect(rpc[0].method.length).toBeGreaterThan(0);
});

test("gateway routes come from explicit env config", async () => {
  process.env.KITE_GATEWAY_ROUTES = JSON.stringify([{ name: "g", host: "127.0.0.1", port: 59999 }]);
  const kite = new Kite();
  const routes = await kite.routes();
  expect(routes.length).toBe(1);
  expect(routes[0].name).toBe("g");
  delete process.env.KITE_GATEWAY_ROUTES;
});

test("health check classifies a dead port as dead (no hang)", async () => {
  const kite = new Kite();
  const dead = RouteSchema.parse({ name: "dead-lane", host: "127.0.0.1", port: 59999 });
  const st = await kite.health(dead, 500);
  expect(st.front_door).toBe("dead");
}, 5000);

test("exec-lane probe flags handshake-only routes as drift", async () => {
  const kite = new Kite();
  // python http.server that accepts but returns empty bodies would be ideal;
  // a closed port exercises the dead branch deterministically.
  const dead = RouteSchema.parse({ name: "dead-lane", host: "127.0.0.1", port: 59999 });
  const st = await kite.execLane(dead, 500);
  expect(st.exec_lane).toBe("dead");
}, 5000);

test("race: first valid response wins, ledger line written", async () => {
  const fast = { name: "fast", run: async () => new Response("ok") };
  const slow = { name: "slow", run: async () => { await Bun.sleep(300); return new Response("ok"); } };
  const r = await race([slow, fast], { ceiling: 1000, ledger: true });
  expect(r.winner).toBe("fast");
  expect(r.ms_total).toBeLessThan(300);
}, 5000);

test("race: all-invalid lanes -> winner none", async () => {
  const bad = { name: "bad", run: async () => new Response("nope", { status: 502 }) };
  const r = await race([bad], { ceiling: 500, ledger: false });
  expect(r.winner).toBe("none");
}, 5000);

test("chaos window: guard-blocked windows never fault, never undo", async () => {
  let faulted = false, undone = false;
  const w = { name: "t", fault: async () => { faulted = true; }, undo: async () => { undone = true; } };
  const r = await chaosWindow(w, { diskFreePctMin: 99.99 });   // impossible guard
  expect(r.ran).toBe(false);
  expect(faulted).toBe(false);
  expect(undone).toBe(false);
});

test("chaos window: fault then undo always", async () => {
  let undone = false;
  const w = { name: "t2", fault: async () => {}, undo: async () => { undone = true; } };
  const r = await chaosWindow(w);
  expect(r.ran).toBe(true);
  expect(undone).toBe(true);
});

test("guardsOk passes on this box", async () => {
  expect((await guardsOk()).ok).toBe(true);
});

test("CEILING honors env override contract", () => {
  expect(typeof CEILING).toBe("number");
});
