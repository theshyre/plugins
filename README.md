# Shyre plugins

Plugins for coding agents that work with [Shyre](https://shyre.io).
Shyre keeps the record of work a business bills and budgets from: time that logs itself as people and their coding agents work, turned into proposals, invoices and signed sign-offs for consultants, and cost reports for teams.
Today there is one plugin: **shyre**, deterministic time tracking for agent
sessions.

**Latest release:** 1.6.1 (2026-09-09) — see `CHANGELOG.md`.

```bash
claude plugin marketplace add theshyre/plugins
claude plugin install shyre@theshyre
export SHYRE_API_KEY="shyre_pat_…"   # from Settings → Integrations in Shyre
```

That is the whole setup for Claude Code. Then turn on auto-update for the
marketplace once — `/plugin` → **Marketplaces** → **theshyre** → **Enable
auto-update** — so releases land on the next launch; Claude Code leaves it
off for every marketplace that is not Anthropic's, and until you flip it the
plugin says so at session start, once a day, and says when a newer version
exists.

## What it does

- **Time logs itself.** Every session records each run of activity as a
  time entry on the right project, with the agent named on the entry and
  both meters on it: the human's attended time and the machine's runtime.
  Entries post while you work — a run that ends at an idle gap posts at
  once, and an open run with more than half an hour unposted posts a
  checkpoint when the agent's turn ends — so a day's work is in Shyre while
  it happens, not at the end of the day.
- **Tokens ride along.** When Claude Code's metrics exporter is on, the
  session's token counts, model and list-price estimate travel with the last
  run. Absent is absent, never zero.
- **Nothing is invented.** A run under a minute is dropped; a run mapped to
  an archived project is kept back with the reason; a window an entry
  already covers is skipped; an entry that cannot be delivered waits, and is
  dropped only after the server has been told.
- **The MCP server signs in through the browser.** The first Shyre tool a
  session uses opens a tab, you pick the team and click Allow, and the agent
  holds a token nobody typed — fifteen tools, from "start a timer" to "draft
  the release notes". The hooks have no browser, so they read
  `SHYRE_API_KEY` from the shell that launches `claude`.
- **`log-your-time`**, the skill: how an agent logs a categorized,
  invoice-ready entry at the end of a unit of work.
- **Backfill.** `backfill --since=YYYY-MM-DD --dry-run` reconstructs runs
  from this machine's Claude Code transcripts for sessions before the plugin
  was installed — timestamps only — and logs them marked *backfilled*.

Codex and Cursor use the same runtime through its installer; the
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
