# Changelog

All notable changes to the `shyre` plugin. The version is the one in
`plugins/shyre/.claude-plugin/plugin.json`; each release is tagged `v<version>`
here and `plugin-v<version>` in the Shyre repository.

## 1.0.1 — 2026-09-03

- The MCP server origin is fixed to `https://shyre.malcom.io` in the
  plugin's `.mcp.json`. It was an environment interpolation, which let a
  repository's `.envrc` or a devcontainer choose where the bearer token was
  sent; the runtime already refused a non-https origin, and the MCP half now
  cannot be redirected either. Self-hosters edit the URL in the installed copy.
- The runtime carries its MIT notice and SPDX identifier, since it is also
  distributed on its own by `curl`.
- `doctor` prints four characters of the token after the prefix, not six.
- The plugin's homepage is this repository; the in-app guide needs a Shyre
  account.
- Each release publishes `plugins/shyre/hooks/shyre-hook.mjs.sha256` beside
  the runtime, so a downloaded copy can be verified.

## 1.0.0 — 2026-09-03

First release as a plugin, replacing the copied shell and PowerShell scripts.

- One Node runtime for every agent: Claude Code (this plugin), Codex and
  Cursor (`node shyre-hook.mjs install <agent>`).
- Context compaction no longer discards the session.
- One entry per run of activity with its real start and end, instead of one
  fabricated window per session.
- Session end does no network: runs are spooled under `~/.shyre` and
  delivered by a detached flush, swept again on the next start.
- Every refusal, stand-down and unmapped repository is written to
  `~/.shyre/refusals.log` with the server's reason.
- The project is resolved from the repository's remote against the project's
  GitHub repository in Shyre; a map file is optional.
- Both agent meters (machine working, agent waiting) computed from the hook
  tags; never summed into the hours.
- The agent is identified from the hook payload, so a Cursor session fired
  through this plugin is recorded once, as Cursor.
