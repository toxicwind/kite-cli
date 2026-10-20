<div align="center">

# kite-cli

**Your muse.ai agent, driven from the terminal — by you, or by other agents.**

[![license](https://img.shields.io/github/license/toxicwind/kite-cli?style=for-the-badge)](https://github.com/toxicwind/kite-cli/blob/main/LICENSE)
[![stars](https://img.shields.io/github/stars/toxicwind/kite-cli?style=for-the-badge)](https://github.com/toxicwind/kite-cli/stargazers)
[![website](https://img.shields.io/badge/website-live-3fb950?style=for-the-badge)](https://kite-cli-site.web.app)
[![release](https://img.shields.io/badge/release-0.3.2-0969da?style=for-the-badge)](https://github.com/toxicwind/kite-cli/releases)
[![transport](https://img.shields.io/badge/transport-Noise_XX_25519_AESGCM-0969da?style=for-the-badge)](docs/PROTOCOL.md)
[![gateway](https://img.shields.io/badge/gateway-258_methods_·_5_services-8957e5?style=for-the-badge)](src/kite_cli/routes.json)

![kite-cli hero](https://raw.githubusercontent.com/toxicwind/kite-cli/main/assets/hero.webp)

</div>

kite-cli speaks the muse.ai app's own protocol directly: HTTPS auth →
encrypted Noise-XX WebSocket → protobuf envelopes → your personal VM. No
browser, no scraping, no middleman. Chat, side chats, feed, goals, ideas,
sessions — and the surfaces nobody else implements: the **cell filesystem**,
the **activity feed**, and **executable cron endpoints**.

## Why "kite"?

The name is doctrine, not branding. Security tooling kept tripping brittle
LLM refusals on canonical binary names — so the estate's [`ferret-den`](https://github.com/toxicwind/ferret-den)
MCP server decouples them: `den:whisker` runs `subfinder`, `den:fang` runs
`nuclei`. _The agent sees the job; the name stays out of the catalog._

The platform client got the same treatment. The muse.ai runtime cell was
codenamed `hatch` — operationally renamed **kite**, which is both a young
ferret (a _kit_, pairing with `ferret-den`) and the bird: swift, sharp, four
letters. The estate's agents wear the same class of names — osprey, finch,
wraith, sable. `hatch` survives only as a backward-looking provenance tie.

Started as a fork of [`nikships/muse-cli`](https://github.com/nikships/muse-cli)
(history preserved); it has since diverged into its own client with a
reverse-engineered, live-validated view of the whole platform.

---

## Why this fork exists

|                      | muse-cli (upstream)       | kite-cli                                                                                                            |
| -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Gateway methods      | core chat/feed/goals      | **all 258 methods**, including `noiseOnly` routes the route table doesn't even list                                 |
| Cell filesystem      | —                         | `cell` command family over the gateway's `fs.*` routes: read/write/mv/rm the agent's home                           |
| Executable endpoints | —                         | `cron put/rm/list` — schedule work inside the agent's cell                                                          |
| Live tail            | basic watch               | activity cards, agent status, task and approval events                                                              |
| Warm connection      | reconnects every call     | `kite-daemon` holds the Noise session open; `kite-fast` answers in milliseconds                                     |
| Protocol knowledge   | first reverse-engineering | **live-validated**: 5-service mux, notary endorsement chain, edge API — see the [decode repos](#protocol--research) |

## Quick start

```bash
uv tool install kite-cli      # or: pipx install kite-cli   /   pip install kite-cli
```

> The command is `kite-cli`. The name `muse` belongs to Muse Code on many machines.

Auth is a one-time cookie export from Chrome (the same login your browser
already has):

```bash
kite-cli auth export     # drives Chrome remote debugging, saves cookies (chmod 600)
kite-cli status          # verifies the full chain: auth → noise → your VM
```

<details>
<summary>Auth setup in detail</summary>

1. **Install the cookie reader** — `kite-cli auth export` needs Chrome with
   remote debugging; the command guides you through it.
2. **Be logged in** to muse.ai in that Chrome profile.
3. **Export** — cookies are saved to `~/.config/kite-cli/cookies.txt`
   (`chmod 600`), never anywhere else.
4. **Verify** — `kite-cli status` auto-discovers your VM and prints the
   agent identity.

Cookies expire with the browser session; re-run `auth export` when status
starts failing. Manual copy: see `kite-cli auth export --help`.
</details>

## Commands

```bash
# chat
kite-cli send "summarize my unread" --wait 120    # send + wait for the reply
kite-cli history --limit 5                        # recent messages
kite-cli history --thread <session-id>            # one side chat
kite-cli watch --timeout 60                       # live agent events
kite-cli threads                                  # main chat + side chats

# the agent's cell (gateway fs.* routes)
kite-cli cell list .                              # cell home
kite-cli cell read IDENTITY.md                    # stream a file
kite-cli cell write notes/x.md --data "hi"        # write (--file to upload)
kite-cli cell stat / mv / rm / mkdir              # full file management

# activity + schedules
kite-cli activity --limit 5                       # the agent's work cards
kite-cli cron list                                # registered schedules
kite-cli cron put --kind runonce --id ping \
  --spec 2026-10-20T12:00:00 --data "do a thing"  # executable endpoint
kite-cli cron rm ping

# sessions, feed, goals, ideas
kite-cli session-start --title "trip planning"
kite-cli feed --limit 5        ;  kite-cli feed-react <unit-id> love
kite-cli goals                 ;  kite-cli ideas
kite-cli idea-exec <idea-id>   # agent acts on an idea

# escape hatches
kite-cli raw <method> --body '{}'                 # any of 258 gateway methods
kite-fast raw <method> --body '{}'                # same, over the warm daemon
```

Every command prints JSON — pipe into `jq`, cron, or another agent:

```bash
kite-cli send "what's on my calendar today?" | jq -r .reply.text
```

## Built for agents driving agents

The design center: your coding agent activates the bundled skill and drives
your muse.ai agent **read-only** while you keep working — no browser, no
tab-switching, no hand-copied context.

- `skills/kite-cli/SKILL.md` ships with the installer: install check, auth
  setup, the full command reference, and a strict usage contract (an agent
  can't send, react, or execute on your behalf unless you say so)
- `profiles/kite-agent.md` — non-interactive, JSON-first profile for
  non-human operators
- every command emits JSON, so `kite-cli` composes with `jq`, cron jobs,
  CI steps, and other agents' tool loops

## Architecture

```
kite-cli ─┬─ HTTPS  cookies → /api/auth/check → access token
          │         /api/hatch/token {vmAddress, vmName} → hatch token
          │
          ├─ wss://hatch.metaaivm.com/v1/noise?vm_id=…&auth_token=…
          │    Noise_XX_25519_AESGCM_SHA256  (ephemeral static key)
          ▼
       protobuf envelopes  NoiseTransportFrame → ServiceRequest → ServiceFrame
          │                 services: daemon 0 · sentinel 1 · vault 2 · authd 3 · ssh_access 4
          ▼
       your personal VM — chat, fs, tasks, feed, goals, approvals, …
```

- **Warm mode:** `kite-daemon` keeps the Noise session open and serves
  `kite-fast` over `~/.config/kite-cli/daemon.sock` — no 2-6s handshake per
  call.
- **Notary-protected routes:** sensitive routes (the whole `ssh_access`
  service) require per-route endorsement tokens; the full chain is
  implemented and live-validated — see
  [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Protocol & research

The protocol notes are decode-driven and continuously re-verified against
live traffic:

| Resource                                                                                             | What's inside                                                                                        |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [docs/PROTOCOL.md](docs/PROTOCOL.md)                                                                 | auth chain, Noise transport, framing, the 5-service mux, notary endorsements, server quirks          |
| [src/kite_cli/routes.json](src/kite_cli/routes.json)                                                 | all 258 gateway methods with paths and services                                                      |
| [muse-web-bundle-decode](https://github.com/toxicwind/muse-web-bundle-decode)                        | decoded web client: 161 edge API paths, SSH access chain, auto-decoder middleman (`noise_middec.py`) |
| [hatch-decode · pass 4](https://github.com/toxicwind/hatch-decode/blob/main/pass4/FINDINGS-pass4.md) | the cell binary: `ssh_access.rs`, ingress trust, peerd, quota machinery                              |
| [estate-recon / muse-meta-hatch](https://github.com/toxicwind/estate-recon)                          | runtime-cell architecture and field docs                                                             |

## Development

```bash
git clone https://github.com/toxicwind/kite-cli && cd kite-cli
uv sync && uv run pytest          # unit tests
uv run kite-cli status            # against your real VM
```

- `tests/probe_fs_shapes.py` / `tests/probe_fs_write.py` — executable
  documentation of the `fs.*` request schemas, discovered live
- `tests/repo_cli.py` — run the repo source against the installed venv deps
- `scripts/hero_gen.py` — regenerates the hero banner deterministically
  (`hero-gen` if you symlink it); no design tool required

## Provenance

Forked from [`nikships/muse-cli`](https://github.com/nikships/muse-cli) —
thanks for the original reverse-engineering groundwork. Since the fork:
endpoint coverage went from core to full (including `noiseOnly` routes),
the cell/activity/cron families were added, the daemon mode was built, and
the protocol documentation was rewritten from live traffic. MIT, same as
upstream.

## License

MIT — see [LICENSE](LICENSE).
