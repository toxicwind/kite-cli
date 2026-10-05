<div align="center">

# kite-cli

Talk to your personal muse.ai AI agent from the terminal.

[![PyPI](https://img.shields.io/pypi/v/kite-cli?style=for-the-badge)](https://pypi.org/project/kite-cli/)
[![Python](https://img.shields.io/pypi/pyversions/kite-cli?style=for-the-badge)](https://pypi.org/project/kite-cli/)
[![Downloads](https://img.shields.io/pepy/dt/kite-cli?style=for-the-badge)](https://pepy.tech/project/kite-cli)
[![License: MIT](https://img.shields.io/github/license/toxicwind/kite-cli?style=for-the-badge)](https://github.com/toxicwind/kite-cli/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/toxicwind/kite-cli?style=for-the-badge)](https://github.com/toxicwind/kite-cli/stargazers)
[![Website](https://img.shields.io/badge/website-live-3fb950?style=for-the-badge)](https://kite-cli-site.web.app)

![kite-cli hero](https://raw.githubusercontent.com/toxicwind/kite-cli/main/assets/hero.webp)

</div>

> **Fork:** this is [`toxicwind/kite-cli`](https://github.com/toxicwind/kite-cli),
> the canonical fork for the hatch/ipnext agent estate. Upstream is
> [`nikships/muse-cli`](https://github.com/nikships/muse-cli); its history is
> preserved. Estate additions: the [hatch-agent profile](profiles/hatch-agent.md)
> (non-interactive, JSON-first setup for agents) and [estate bridge notes](docs/ESTATE.md).

## What is this?

A command-line client for your personal muse.ai AI agent: chat from the terminal, automate it with scripts, and manage side chats, feed, goals, ideas, and sessions without opening a browser. It speaks the app's own gateway protocol directly: HTTPS auth, then an encrypted Noise-XX WebSocket to your personal VM.

- **Chat from the shell:** send a message and get the agent's reply back as JSON.
- **Script it:** every command prints JSON, so it pipes into `jq`, cron jobs, and other AI agents.
- **Full coverage:** named commands for the common tasks, plus a `raw` escape hatch for all 258 gateway methods.
- **Agent-ready:** ships an agent skill so coding agents can drive your muse.ai agent for you.

## Agents driving agents

Prompt a coding agent, it activates the kite-cli skill and runs read-only
commands for you. Live session below: a Droid worker runs `kite-cli status`
and `kite-cli goals`, then reports back.

![Droid agent using kite-cli to check status and goals](https://raw.githubusercontent.com/toxicwind/kite-cli/main/assets/demo-agent.png)

## Quick Start

```bash
uv tool install kite-cli      # or: pipx install kite-cli   /   pip install kite-cli
```

The command is `kite-cli`. The name `muse` belongs to Muse Code on many machines.

Want the agent skill too? The installer sets up the CLI and copies the skill
to `~/.agents/skills/kite-cli`:

```bash
curl -fsSL https://raw.githubusercontent.com/toxicwind/kite-cli/main/install.sh | bash
```

Upgrade with `kite-cli update`. In a terminal it also checks PyPI once a day and, when a newer release exists, prints that command on stderr. It does not upgrade itself. Set `MUSE_NO_UPDATE_CHECK=1` to silence the notice. The check stays quiet when output is piped or `CI` is set. Remove with `uv tool uninstall kite-cli`.

Logging in is a separate one-time step. Chrome shares its cookies after you
turn on remote debugging. Follow [Log in once](#log-in-once) before running
any other command.

## Log in once

kite-cli borrows the login you already have in Chrome, saves those cookies
to `~/.config/kite-cli/cookies.txt` (mode `600`, only your user can read it),
and after that talks to muse.ai directly. Access tokens are fetched fresh
on every command. When a command later says the cookies expired, repeat this
section.

Do the steps in order. Each one checks itself before you continue.

### 1. Install the cookie reader

`auth export` uses [agent-browser](https://github.com/vercel-labs/agent-browser)
to read Chrome's cookies. That package comes from npm, so you need Node.js first.

```bash
node --version    # if this fails, install Node.js LTS from https://nodejs.org
                  # and open a new terminal
npm i -g agent-browser
agent-browser --version
```

`npm i -g` needs permission to write to npm's global bin directory. If it
errors with `EACCES`, pick one and use it from then on: configure an
[npm prefix you own](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally),
or run the install with the same rights you use for other global npm tools.
Then check `command -v agent-browser` prints a path.

### 2. Let Chrome share cookies

Open **Google Chrome**, the same profile you use for muse.ai. Paste this in
the address bar:

```
chrome://inspect/#remote-debugging
```

Turn on remote debugging. The checkbox reads **Allow remote debugging for
this browser instance**. Leave Chrome open.

Turn this on while Chrome is already open and muse.ai is loaded. The export
can see that window only after the switch is on. The page is in Chrome 144
and newer.

Stay in this window. Starting a second Chrome with
`--remote-debugging-port` opens a different profile, and that profile does
not have your muse.ai login.

### 3. Be logged in, on a muse.ai tab

In that same Chrome window, open https://muse.ai/ and log in. Leave the tab
open. The exporter reads whichever tab is active, so the muse.ai tab has to
be the one in front when you run the next command.

### 4. Save the login

```bash
kite-cli auth export
```

Chrome may ask to allow the debugging connection. Click **Allow**. If the
command already failed, run it again after you click Allow.

Success looks like this (the count varies):

```
saved 12 muse.ai cookies to /home/you/.config/kite-cli/cookies.txt
```

The command prints the fix on the failure itself. These are the ones it
recognizes:

| What it says | What to do |
| --- | --- |
| No running Chrome / remote debugging | The switch in step 2 is off. Turn it on in the Chrome you already have open, then run the command again. |
| No muse.ai tab | Step 3. Open https://muse.ai/ in that same window and leave the tab open. |
| No `hatch_sess` | The tab is open and you are logged out. Log in, then export again. The cookies file already on disk is left as it was. |
| `agent-browser` is not installed | Step 1. `node --version`, then `npm i -g agent-browser`, then a new terminal. |
| Daemon already running | A previous attempt is stuck. `agent-browser close`, then `kite-cli auth export`. |

### 5. Check the connection

```bash
kite-cli status
```

You get JSON with your VM id, how many chats you have, the unread count, and
your identity. That means install and login both worked.

### Copy cookies by hand

Use this when you don't have Node, or you don't want remote debugging on.

1. In Chrome, open https://muse.ai/ and log in.
2. Open DevTools (F12, or Ctrl+Shift+I) → **Application** → **Cookies** → `https://muse.ai`.
3. Copy the cookies onto one line. `hatch_sess` has to be there. Separate cookies with `; ` (semicolon, space). A Netscape cookie jar (what curl writes) and a JSON object such as `{"hatch_sess": "..."}` also work.

```bash
mkdir -p ~/.config/kite-cli
printf '%s\n' 'hatch_sess=the-value-from-devtools; other_cookie=other_value' > ~/.config/kite-cli/cookies.txt
chmod 600 ~/.config/kite-cli/cookies.txt
kite-cli status
```

## Usage

```bash
kite-cli threads                                  # main chat + side chats
kite-cli history --limit 5                        # recent messages
kite-cli history --thread <session-id> --limit 5  # one side chat
kite-cli send "summarize my unread" --wait 120    # send + wait for the reply
kite-cli watch --timeout 60                       # tail live agent events

kite-cli feed --limit 5
kite-cli feed-react <unit-id> love
kite-cli goals
kite-cli ideas
kite-cli idea-exec <idea-id>                      # agent acts on the idea

kite-cli session-start --title "trip planning"    # new side chat
kite-cli session-rename <id> "new title"
kite-cli session-archive <id>                     # also: pin, unpin, unarchive, delete
kite-cli seen <thread-id>
kite-cli wake
kite-cli raw <method> --body '{}'                 # escape hatch: any of 258 gateway methods
```

Every command prints JSON. Your VM is auto-discovered from your session, and a
random device id is generated on first run.

Pipe it into other tools:

```bash
kite-cli send "what's on my calendar today?" | jq -r .reply.text
```

## How it works

![how kite-cli connects](https://raw.githubusercontent.com/toxicwind/kite-cli/main/assets/how-it-works.webp)

![kite-cli connection flow](https://raw.githubusercontent.com/toxicwind/kite-cli/main/assets/flow.webp)

See [docs/PROTOCOL.md](https://github.com/toxicwind/kite-cli/blob/main/docs/PROTOCOL.md)
for the full protocol notes, including the method table and the server quirks
found during reverse engineering.

## Documentation

| Resource | Description |
|----------|-------------|
| [skills/kite-cli/SKILL.md](https://github.com/toxicwind/kite-cli/blob/main/skills/kite-cli/SKILL.md) | Agent skill: install check, auth setup, command reference |
| [docs/PROTOCOL.md](https://github.com/toxicwind/kite-cli/blob/main/docs/PROTOCOL.md) | Gateway protocol reference: auth chain, Noise transport, framing, method quirks |
| [routes.json](https://github.com/toxicwind/kite-cli/blob/main/src/kite_cli/routes.json) | All 258 gateway methods with paths and services |
| [profiles/hatch-agent.md](https://github.com/toxicwind/kite-cli/blob/main/profiles/hatch-agent.md) | Agent profile: non-interactive hatch/ipnext setup, usage contract, security notes |
| [docs/ESTATE.md](https://github.com/toxicwind/kite-cli/blob/main/docs/ESTATE.md) | Fork notes: protocol cross-reference, harvest provenance |
| `kite-cli raw --help` | Escape hatch for calling any gateway method directly |

## Development

```bash
git clone https://github.com/toxicwind/kite-cli.git
cd kite-cli
uv run kite-cli --help
```

```
kite-cli/
assets/              README artwork (generated with Muse Image)
docs/PROTOCOL.md     protocol reference for re-derivation
skills/kite-cli/     agent skill
src/kite_cli/
  cli.py             argument parsing and all commands
  gateway.py         gateway client (auth, Noise transport, subscriptions)
  routes.json        258 gateway methods extracted from the web client
  desc0.bin          protobuf descriptors for the wire framing
  desc1.bin
install.sh           CLI + skill installer
pyproject.toml
```

## Setup notes

- Login is the [Log in once](#log-in-once) section above. Cookies live at
  `~/.config/kite-cli/cookies.txt` (mode 600). Access and gateway tokens are
  fetched fresh on every run.
- `auth export` reads those cookies from Google Chrome through
  [agent-browser](https://github.com/vercel-labs/agent-browser). Chrome has
  to be open, with remote debugging on
  (`chrome://inspect/#remote-debugging`) and a logged-in muse.ai tab in front.
- Respect muse.ai's terms and rate limits. Internal APIs are unversioned and
  can change; if calls fail, re-derive from a fresh app bundle.

## Contributing

Issues and PRs welcome. If the protocol drifts, the most useful contribution
is a note of which method broke and the new server error text.

<a href="https://github.com/toxicwind/kite-cli/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=toxicwind/kite-cli" />
</a>

## License

MIT. See [LICENSE](https://github.com/toxicwind/kite-cli/blob/main/LICENSE).

---

<div align="center">

[![Star History Chart](https://api.star-history.com/svg?repos=toxicwind/kite-cli&type=Date)](https://star-history.com/#toxicwind/kite-cli&Date)

</div>
