# Shyre plugins

Plugins for coding agents that work with [Shyre](https://shyre.malcom.io),
the time-tracking and invoicing platform for consultants. Today there is one:
**shyre**, deterministic time tracking for agent sessions.

```bash
claude plugin marketplace add theshyre/plugins
claude plugin install shyre@theshyre
export SHYRE_API_KEY="shyre_pat_…"   # from Settings → Integrations in Shyre
```

That is the whole setup for Claude Code. Every session then records each run
of activity as a time entry on the right project, with the agent named on
the entry. The plugin also ships the Shyre MCP server (fifteen tools, from
"start a timer" to "draft the release notes") and the `log-your-time` skill.

Codex and Cursor use the same runtime through its installer; the
[agent hooks kit guide](https://shyre.malcom.io/docs/guides/features/agent-hooks-kit)
has the commands, what gets measured, what leaves the machine, and how to
check it is working.

## What is in here

| Path | What |
| --- | --- |
| `.claude-plugin/marketplace.json` | The marketplace manifest Claude Code reads |
| `plugins/shyre/` | The plugin: `hooks/hooks.json`, `hooks/shyre-hook.mjs`, `.mcp.json`, `skills/log-your-time` |

This repository is a **build output**. The plugin is developed, tested and
reviewed inside the Shyre repository and published here on each release, so
issues and changes belong there; open an issue on this repository and it
will be routed. `CHANGELOG.md` lists what each version changed.

## License

MIT. See `LICENSE`. The Shyre service itself is proprietary; this plugin is
a client for it.
