# @toxicwind/kite — API (forward audit 2026-10-28, suite 33/33)

Noise_XX_25519_AESGCM_SHA256 in pure Bun (node:crypto only) + fleet toolbus.
Cross-impl PROVEN against the python SSOT (`/mnt/nvme0n1/cell-mirror/noise_build`, 58/58).

## Modules

| Module | Exports | Test ref |
|---|---|---|
| `noise` | `PROTOCOL_NAME`, `NoiseHandshakeState` (standard+custom XX), `CipherState`, `SymmetricState`, `x25519Generate`, `rawPublic`, `importPrivateRaw`, `importPublicRaw` | `test/interop.test.ts` (msg1 byte-exact + full bun↔python XX), `test/interop-vector.test.ts` (fixed-key gate) |
| `pcap` | `parsePcapng`, `idbLinktype`, `epbPackets`, `extractTCPPayloads`, `reassembleStream`, `replayNoiseMsg1`, `pcapExtract` | `test/pcap.test.ts` (spec-first, kappa) |
| `provenance` | `isUnreliable`, `unpoison` (dated-outlet gate; aggregators/bare-schemes = poison) | `test/toolbus.test.ts` |
| `race` | `race(lanes) -> {winner, latencies, errors, ms_total}`, `bench`, `CEILING`, `FLOOR` | `test/kite.test.ts`, `test/toolbus.test.ts` |
| `chaos` | `guardsOk`, `chaosWindow` (fault windows gated on disk/temp) | `test/kite.test.ts` |
| `a2a` | `A2A` (heartbeat/direct/inbox/roomPost/roomRead/exec), `tauA2A()` | `test/kite.test.ts` |
| `soul` | `SoulAdapter` (soul.md/identity.md/memories.md hot-read), `remember()` idempotent + self-healing dir | `test/soul.test.ts` |
| `gateway` | `GatewayClient` (Noise wss, chunked frames), keepalive+reconnect | `test/kite.test.ts` |
| `toolbus` | `startToolbus(port)`, `handle`/`callTool`, `TOOLS` | `test/toolbus.test.ts` |

## Toolbus — daemon-as-peer API

```
GET  /health       -> {ok, tools[], pid}
GET  /tools/list   -> {tools: [{name, description, inputSchema}]}
POST /tools/call   -> {name|tool, arguments|args|params} -> {ok, tool, out}
```

Tools (10): `noise-selftest` · `noise-respond` · `noise-interop` · `b64read` · `pcap-extract` · `provenance` · `race` · `chaos-guards` · `a2a-direct` · `soul-remember`

- **noise-respond**: submit initiator msg1 hex → real responder msg2 (pinned daemon static = stable peer identity; session map held for msg3/transport). The gateway peer (hatch.metaaivm.com) was captured by a CDN — so the daemon IS the peer now.
- **noise-interop**: live python-SSOT byte-compare every call.

## Cross-impl contract (hard-won, keep green)

1. AAD is MANDATORY on every keyed op (`h` is the AD) — a missing `setAAD` cancels symmetrically bun↔bun and silently poisons cross-impl. Caught only by live python interop.
2. XX msg2 es on the initiator = `DH(ephemeral_i, static_r)` — NOT `DH(static_i, ephemeral_r)`.
3. Standard nonce = `4×00 || u64le(n)`; ct||tag (python AESGCM order).
4. Interop fixtures: `test/fixtures/interop_vector.py` (+ argv mode), `test/interop_respond_vec.py`.
5. Route status: `hatch.metaaivm.com` is CDN-captured (502 FB page) — see `docs/route-status.md`.
