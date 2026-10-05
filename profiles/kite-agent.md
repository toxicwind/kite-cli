# kite-cli — hatch/ipnext agent profile

This profile makes `kite-cli` first-class for agents running on the hatch
runtime (skills autoloaded) or the ipnext inference substrate. It is the
non-interactive, JSON-first way to drive a personal Muse AI agent.

## Identity

- Profile: `hatch-agent`
- Applies to: agents with the hatch autoloaded-skills identifier or the
  ipnext substrate identifier.
- Transport: `wss://hatch.metaaivm.com/v1/noise?vm_id=<id>` —
  `Noise_XX_25519_AESGCM_SHA256`, protobuf envelopes
  (`ingress_rev_proxy.NoiseTransportFrame`, `hatch.noise.ServiceRequest`).
- VM addressing: `wss://<vm-id>.metaaivm.com/`.

## Non-interactive setup

No browser after the one-time cookie export. All state is files + env:

```bash
# cookies provisioned once (mode 0600), then never touched interactively
ls -l ~/.config/kite-cli/cookies.txt
# env overrides (no config file edits needed)
export MUSE_VM_ID="<vm-id>"
export MUSE_NODE_ID="<node-id>"   # optional
```

Install (isolated, no repo clone needed):

```bash
curl -fsSL https://raw.githubusercontent.com/toxicwind/kite-cli/main/install.sh | bash
command -v kite-cli && kite-cli --help >/dev/null && echo cli-ok
```

## Usage contract for agents

- Every command prints JSON. Parse stdout, never scrape prose.
- `kite-cli chat send --text "..."` / `kite-cli chat history` / side chats /
  feed / goals / ideas / sessions — see `kite-cli --help`.
- Never run `kite-cli auth export` from an agent lane: it needs a live
  Chrome remote-debugging session. Cookies are provisioned, not exported.
- Cookie rotation: if a call raises AuthError, re-provision
  `~/.config/kite-cli/cookies.txt` out-of-band and retry once.

## Security notes

- Upstream issue `nikships/muse-cli#1` (the gateway WebSocket did not verify
  TLS certificates) is fixed in this fork: `gateway.py` connects with
  `verify=True` (upstream commit `9406cbb`, released in 0.3.2, inherited here
  with full history; guarded by `tests/test_smoke.py`). Only pre-0.3.2
  installs should be treated as untrusted on the wire.
- `cookies.txt` is a bearer credential: 0600, never logged, never committed.
