// @toxicwind/kite — Bun-native core of the kite/hatch gateway.
// Lineage: kite == hatch; yote == awrawr-pc == tailscale == bridge master
// == chaos harness. One tool, one namespace — this lib is the bun-grade
// programmatic surface of it.
//
// Doctrine carried over from the python core (src/kite_cli):
//   routes.json is the declarative SSOT; tailscale serve state is mutable
//   and distributed — DRIFT CHECK is a first-class op, never assume.
//   Gateway health = GET /health; a route can be alive at the front door
//   and dead at the exec lane (ROUTE CONTRACT, anomaly #5).

import { z } from "zod";

export const RpcRouteSchema = z.object({
  method: z.string().min(1),
  http: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
  path: z.string().min(1),
});
export type RpcRoute = z.infer<typeof RpcRouteSchema>;

export const RouteSchema = z.object({
  name: z.string().min(1),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535),
  path: z.string().default("/"),
  kind: z.enum(["http", "ws", "tls-ws"]).default("http"),
  health: z.string().optional(),          // expected health path
  expected_status: z.number().int().default(200),
  auth: z.enum(["none", "token", "oauth-wall"]).default("none"),
});
export type Route = z.infer<typeof RouteSchema>;

export const GatewayStatusSchema = z.object({
  route: z.string(),
  front_door: z.enum(["alive", "dead", "unknown"]),   // health/models
  exec_lane: z.enum(["alive", "dead", "unknown"]),    // real end-to-end
  latency_ms: z.number(),
  drift: z.boolean(),
});
export type GatewayStatus = z.infer<typeof GatewayStatusSchema>;

const H1_AGENT_OPTS = { connections: 32, pipelining: 1 } as const;

/** kite client — route table ops + health + drift, HFT-grade. */
export class Kite {
  private routesFile: string;
  private hot = new Map<string, number>();   // route key -> last good latency

  constructor(opts: { routesFile?: string } = {}) {
    this.routesFile = opts.routesFile
      ?? (process.env.KITE_ROUTES ?? `${process.env.HOME}/pens/hatch-kite-cli/src/kite_cli/routes.json`);
  }

  /** RPC surface map from routes.json (the python core's SSOT). */
  async rpcRoutes(): Promise<RpcRoute[]> {
    const raw = JSON.parse(await Bun.file(this.routesFile).text());
    const list = Array.isArray(raw) ? raw : (raw.routes ?? []);
    return list.map(r => RpcRouteSchema.parse(r));
  }

  /** Gateway routes (host/port lanes) — explicit list or env JSON. */
  async routes(): Promise<Route[]> {
    const env = process.env.KITE_GATEWAY_ROUTES;
    if (env) return JSON.parse(env).map((r: unknown) => RouteSchema.parse(r));
    return [];
  }

  /** Front-door check: HTTP health with h1.1 pinning, under CEILING ms. */
  async health(route: Route, ceilingMs = 2000): Promise<GatewayStatus> {
    const t0 = performance.now();
    const url = `http://${route.host}:${route.port}${route.health ?? "/health"}`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(ceilingMs),
        headers: { "connection": "keep-alive" },   // h1.1 keep-alive hot lane
        keepalive: true,
      });
      const ms = performance.now() - t0;
      const alive = res.status === route.expected_status || res.status === 200;
      this.hot.set(`${route.host}:${route.port}`, ms);
      return { route: route.name, front_door: alive ? "alive" : "dead",
        exec_lane: "unknown", latency_ms: ms, drift: false };
    } catch {
      return { route: route.name, front_door: "dead", exec_lane: "unknown",
        latency_ms: performance.now() - t0, drift: false };
    }
  }

  /** Exec-lane probe: REAL end-to-end request (route contract, not a handshake). */
  async execLane(route: Route, ceilingMs = 4000): Promise<GatewayStatus> {
    const fd = await this.health(route, ceilingMs);
    if (fd.front_door !== "alive") return { ...fd, exec_lane: "dead" };
    const t0 = performance.now();
    try {
      const res = await fetch(`http://${route.host}:${route.port}${route.path}`, {
        method: route.kind === "ws" ? "GET" : "POST",
        body: route.kind === "ws" ? undefined : JSON.stringify({ probe: "kite-exec-lane", ts: Date.now() }),
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(ceilingMs),
      });
      const body = await res.text();
      // a bare handshake (0 bytes / empty body) is NOT a completion
      const real = body.trim().length > 0 && res.status < 500;
      return { ...fd, exec_lane: real ? "alive" : "dead",
        latency_ms: performance.now() - t0,
        drift: fd.front_door === "alive" && !real };   // front door up, exec dead = route drift
    } catch {
      return { ...fd, exec_lane: "dead", latency_ms: performance.now() - t0, drift: true };
    }
  }

  /** Full drift sweep across every route in routes.json. */
  async sweep(ceilingMs = 2000): Promise<GatewayStatus[]> {
    return Promise.all((await this.routes()).map(r => this.execLane(r, ceilingMs)));
  }

  lastGoodLatency(host: string, port: number): number | undefined {
    return this.hot.get(`${host}:${port}`);
  }

  static agentOpts = H1_AGENT_OPTS;
}

export default Kite;
