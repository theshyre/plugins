# Shyre plugin for Claude Code and Codex

Deterministic time tracking for coding-agent sessions, plus the Shyre MCP
server and the log-your-own-time convention, in one installable unit.

Shyre keeps the record of work a business bills and budgets from: time that logs itself as people and their coding agents work, turned into proposals, invoices and signed sign-offs for consultants, and cost reports for teams.

**Latest release:** 1.11.1 (2026-09-18) — see `../../CHANGELOG.md`.

```
claude plugin marketplace add theshyre/plugins
claude plugin install shyre@theshyre
```

**Requires Node.js 18 or later** (`node --version`). The hooks that record
time are a Node.js program; without Node.js the plugin installs and its tools
work, but nothing is recorded.

The plugin keeps itself current (1.10.0): when a newer release exists it asks
Claude Code's own updater to update it (`claude plugin marketplace update
theshyre`, then `claude plugin update shyre@theshyre`), in the background, at
most every six hours; the new version applies at the next session, which says
so once. It fetches nothing itself and trusts no new source.
`SHYRE_HOOK_AUTO_UPDATE=0` turns it off, and it stays off wherever someone
wrote `autoUpdate: false` for the marketplace. It also says so when the token itself is
the problem: `SHYRE_API_KEY` refuses with a 401 on rotation or expiry the
same as on revocation, and a 401 never drops a spooled run — but after three
refused deliveries in a row, session start reports how many times and since
when, and points at `/settings/integrations` to re-mint it; the spooled
runs are kept and are delivered once a working key is in place. `doctor` shows the
same streak on its `token:` line.

The MCP tools sign in on first use: Claude Code opens a browser tab (`/mcp`
→ Authenticate), you pick the team and click **Allow**, and the agent holds
a token nobody typed. For the session hooks — which have no browser — export
`SHYRE_API_KEY` (a personal access token from Settings → Integrations) in
the shell that launches `claude`. That is the whole setup.

In Codex, the same plugin installs from the same marketplace:

```
codex plugin marketplace add theshyre/plugins
codex plugin add shyre@theshyre
```

Run `/hooks` and trust the six shyre hooks. Codex runs no plugin hook until
you do, and asks again when a release changes one. Sign the MCP server in
with `codex mcp login shyre`, which opens the browser. If you set Codex up with
the installer below before, run `node ~/.shyre/bin/shyre-hook.mjs uninstall
codex` first so one set of hooks runs.

What ships:

- `hooks/hooks.json` — SessionStart, UserPromptSubmit, PostToolUse,
  SubagentStop, Stop and SessionEnd all run `hooks/shyre-hook.mjs`, the Node
  runtime that records activity marks and delivers each run of activity by
  extending the agent's own entry beside it on the project (meters and all)
  — at session end, and along the way: a run that ends at an idle gap is
  delivered at once, and an open run with more than half an hour
  undelivered is delivered when the agent's turn ends, so a day's work is in
  Shyre while it happens. A run with no entry beside it waits a day for one, then is
  posted as an entry of its own (1.9.1 — 1.9.0 dropped it); `SHYRE_HOOK_MODE=post` posts without the wait. It is built from `hooks/shyre-hook.ts`, the
  TypeScript source shipped beside it; the artifact is one plain JavaScript
  file with no dependencies, because a hook runs as a bare `node` command.
- `.mcp.json` — the Shyre MCP server. No key in it: the agent signs in
  through the browser and keeps its own token.
- `skills/log-your-time` — how to log categorized, invoice-ready entries at
  the end of a unit of work. In Claude Code the hook prompts for it: a commit
  with fifteen or more unlogged minutes behind it earns the agent a one-line
  note (`SHYRE_LOG_NUDGE_MINUTES`, `0` for off).

Cursor, and Codex without the plugin — including the Codex VS Code extension, which does not support plugins — use the same runtime through its installer. From 1.10.0 that installed copy replaces itself with each new signed release:

```
mkdir -p ~/.shyre/bin
curl -fsSL https://shyre.io/hooks/shyre-hook.mjs -o ~/.shyre/bin/shyre-hook.mjs.part \
  && mv ~/.shyre/bin/shyre-hook.mjs.part ~/.shyre/bin/shyre-hook.mjs
node ~/.shyre/bin/shyre-hook.mjs install codex
node ~/.shyre/bin/shyre-hook.mjs install cursor
```

`node shyre-hook.mjs doctor` prints what the runtime can see. `node
shyre-hook.mjs backfill --since=YYYY-MM-DD --dry-run` reconstructs runs from
this machine's Claude Code transcripts for sessions before the plugin was
installed (timestamps only; drop `--dry-run` to log them, marked backfilled).
The full guide
is at https://shyre.io/docs/guides/features/agent-hooks-kit (Shyre
account required). To verify a downloaded runtime, compare its SHA-256 with the
file at the matching `v<version>` tag in this repository — a second origin. The
checksum served beside it at `/hooks/shyre-hook.mjs.sha256` only shows the
download arrived intact; whoever could serve you a changed runtime could serve
you its hash.
