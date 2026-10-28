# Route status

## Live probe 2026-10-28 (tau)
- 13/13 bun tests green; port byte-faithful to python SSOT (58/58).
- LIVE CONNECTION: **DEAD — not an auth wall.** `hatch.metaaivm.com` CNAME → `edge-metaclaw-http.c10r.facebook.com`, NS `*.ns.facebook.com`; HTTP 502 with Facebook error page on the noise upgrade path.
- Both no-cred and RIG_MUSE-credentialed XX handshakes fail at `gateway ws error` — peer gone, not token wrong.
- Mirror status doc corroborates: live handshake was a documented open gap (never demonstrated).
- Integration verdict: keep `@toxicwind/kite` as protocol-proven lib; do NOT wire into a live daemon until a real peer endpoint exists. Probe script: /home/toxic/tmp/kite-live-probe.ts
