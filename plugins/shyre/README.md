# Shyre plugin for Claude Code

Deterministic time tracking for coding-agent sessions, plus the Shyre MCP
server and the log-your-own-time convention, in one installable unit.

Shyre keeps the record of work a business bills and budgets from: time that logs itself as people and their coding agents work, turned into proposals, invoices and signed sign-offs for consultants, and cost reports for teams.

```
claude plugin marketplace add theshyre/plugins
claude plugin install shyre@theshyre
```

Export `SHYRE_API_KEY` (a personal access token from Settings → Integrations)
in the shell that launches `claude`. That is the whole setup.

What ships:

- `hooks/hooks.json` — SessionStart, UserPromptSubmit, PostToolUse,
  SubagentStop, Stop and SessionEnd all run `hooks/shyre-hook.mjs`, the Node
  runtime that records activity marks and, at session end, spools one time
  entry per run of activity.
- `.mcp.json` — the Shyre MCP server with the bearer token from your
  environment.
- `skills/log-your-time` — how to log categorized, invoice-ready entries at
  the end of a unit of work.

Other agents use the same runtime through its installer:

```
mkdir -p ~/.shyre/bin
curl -fsSL https://shyre.malcom.io/hooks/shyre-hook.mjs -o ~/.shyre/bin/shyre-hook.mjs.part \
  && mv ~/.shyre/bin/shyre-hook.mjs.part ~/.shyre/bin/shyre-hook.mjs
node ~/.shyre/bin/shyre-hook.mjs install codex
node ~/.shyre/bin/shyre-hook.mjs install cursor
```

`node shyre-hook.mjs doctor` prints what the runtime can see. The full guide
is at https://shyre.malcom.io/docs/guides/features/agent-hooks-kit (Shyre
account required). Verify a downloaded runtime against its checksum, served beside it at
`/hooks/shyre-hook.mjs.sha256` and published with each release here.
