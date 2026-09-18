# Shyre plugins

Plugins for coding agents that work with [Shyre](https://shyre.io).
Shyre keeps the record of work a business bills and budgets from: time that logs itself as people and their coding agents work, turned into proposals, invoices and signed sign-offs for consultants, and cost reports for teams.
Today there is one plugin: **shyre**, deterministic time tracking for agent
sessions.

**Latest release:** 1.12.0 (2026-09-18) — see `CHANGELOG.md`.

```bash
claude plugin marketplace add theshyre/plugins
claude plugin install shyre@theshyre
export SHYRE_API_KEY="shyre_pat_…"   # from Settings → Integrations in Shyre
```

That is the whole setup for Claude Code.

**Requires Node.js 18 or later** (`node --version`). The hooks that record
time are a Node.js program; without Node.js the plugin installs and its tools
work, but nothing is recorded.

**It keeps itself current, and you should know how (1.10.0).** Claude Code
auto-updates only Anthropic's own marketplaces by default, so a plugin from
anywhere else sits at the version you installed until you find a toggle three
menus deep. When a newer release exists, this plugin asks **Claude Code's own
updater** to update it — it runs `claude plugin marketplace update theshyre`
and `claude plugin update shyre@theshyre` for you, in the background, at most
every six hours. Nothing is downloaded by the plugin itself and no new source
is trusted: it is the same updater pulling the same repository you installed
from. The new version applies at your next session, which says once that it
updated. A session that was already open when the update landed picks it up by itself (1.12.0): each hook call checks Claude Code's install record and runs the newest installed runtime, so there is nothing to type. Only the hook runtime moves that way — a changed skill or hook wiring still arrives with `/reload-plugins` or the next session — and with updates turned off the session keeps the version it loaded and says so once, at your next prompt. To turn it off: `SHYRE_HOOK_AUTO_UPDATE=0`, or `"auto_update":
false` in `~/.shyre/config.json` — and it stays off wherever anyone has
written `autoUpdate: false` for the marketplace, an administrator's managed
settings included. `node …/shyre-hook.mjs doctor` shows whether it is on and
what it last did.

The Codex CLI installs the same plugin from the same marketplace (Codex
inside the VS Code extension cannot approve hooks, so sessions there are not
recorded):

```bash
codex plugin marketplace add theshyre/plugins
codex plugin add shyre@theshyre
```

Then run `/hooks` in Codex and trust the six shyre hooks; Codex runs no
plugin hook until you do, and asks again when a release changes one. Sign
the MCP server in with `codex mcp login shyre`, which opens the browser. If you used the Codex
installer before, run `node ~/.shyre/bin/shyre-hook.mjs uninstall codex`
first so one set of hooks runs.

## What it does

- **Time logs itself.** Every session's active time lands on the right
  project: each stretch no entry covers extends the agent's own entry beside
  it — keeping that entry's category, description and ticket — and adds both
  meters to it: the human's attended time and the machine's runtime. It
  happens while you work — a run that ends at an idle gap is delivered at
  once, and an open run with more than half an hour undelivered is
  delivered when the agent's turn ends — so a day's work is in Shyre while
  it happens, and never as a stack of uncategorized "session" entries. A
  stretch with no entry beside it waits a day for one, then is posted as an
  entry of its own, so time nobody logged is never lost.
- **Tokens ride along.** When Claude Code's metrics exporter is on, the
  session's token counts, model and list-price estimate travel with the last
  run. Absent is absent, never zero.
- **Nothing is invented.** A run under a minute is dropped; a run mapped to
  an archived project is kept back with the reason; a window an entry
  already covers is skipped; a hand-typed or invoiced entry is never
  extended; an entry that cannot be delivered waits, and is
  dropped only after the server has been told.
- **A dead token says so.** A 401 never drops a spooled run — it survives a
  token rotation — but after three refused deliveries in a row, session
  start reports how many times and since when, and points at
  `/settings/integrations` to re-mint it. `doctor` shows the same streak.
- **The MCP server signs in through the browser.** The first Shyre tool a
  session uses opens a tab, you pick the team and click Allow, and the agent
  holds a token nobody typed — fifteen tools, from "start a timer" to "draft
  the release notes". The hooks have no browser, so they read
  `SHYRE_API_KEY` from the shell that launches `claude`.
- **`log-your-time`**, the skill: how an agent logs a categorized,
  invoice-ready entry at the end of a unit of work — and, in Claude Code, a
  one-line note from the hook when a commit lands with fifteen or more
  unlogged minutes behind it, so the entry does not depend on the agent
  noticing the moment.
- **Backfill.** `backfill --since=YYYY-MM-DD --dry-run` reconstructs runs
  from this machine's Claude Code transcripts for sessions before the plugin
  was installed — timestamps only — and logs them marked *backfilled*.

Cursor, and Codex in the VS Code extension (which does not support plugins), use the same runtime
through its installer, and from 1.10.0 that copy replaces itself with each new signed release; the
[agent hooks kit guide](https://shyre.io/docs/guides/features/agent-hooks-kit)
(Shyre account required) has the commands, what gets measured, what leaves the
machine, and how to check it is working; `plugins/shyre/README.md` here has
the short version.

## What is in here

| Path | What |
| --- | --- |
| `.claude-plugin/marketplace.json` | The marketplace manifest Claude Code reads |
| `plugins/shyre/hooks/` | `hooks.json`, `shyre-hook.ts` (the source) and `shyre-hook.mjs` (its build, the file that runs) |
| `plugins/shyre/.mcp.json` | The Shyre MCP server; no key in it |
| `plugins/shyre/skills/log-your-time` | The skill |
| `plugins/shyre/README.md` | The short guide: setup, what ships, the installer for other agents |
| `CHANGELOG.md` | What each version changed |

This repository is a **build output**. The plugin is developed, tested and
reviewed inside the Shyre repository and published here on each release, so
issues and changes belong there; open an issue on this repository and it
will be routed. To verify a downloaded runtime, compare its SHA-256 with the
file at the matching `v<version>` tag here — a second origin.

## License

MIT. See `LICENSE`. The Shyre service itself is proprietary; this plugin is
a client for it.
