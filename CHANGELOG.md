# Changelog

All notable changes to the `shyre` plugin. The version is the one in
`plugins/shyre/.claude-plugin/plugin.json`; each release is tagged `v<version>`
here and `plugin-v<version>` in the Shyre repository.

## 1.5.0 — 2026-09-08

- **The MCP server signs in.** `.mcp.json` no longer sends a bearer token:
  the first time a session uses a Shyre tool, Claude Code opens the browser
  (`/mcp` → Authenticate), you pick the team and click Allow, and the agent
  holds a token nobody typed — listed under Settings → Integrations as
  *Claude Code — <date>*, revocable there. The hooks are unchanged and still
  read `SHYRE_API_KEY` from the shell that launches `claude`: a hook has no
  browser. The runtime's behavior is unchanged; only its version string moved.

## 1.4.0 — 2026-09-08

- **The third meter: tokens.** At session end the hook reads the agent's own
  metrics exporter on `127.0.0.1` (Claude Code's Prometheus endpoint, on when
  the agent is started with `CLAUDE_CODE_ENABLE_TELEMETRY=1
  OTEL_METRICS_EXPORTER=prometheus`) and sends three more fields on the last
  run of the session: `agent_tokens` (input, output, cache read, cache
  creation, for the model that spent the most), `agent_model`, and
  `agent_cost_usd_list` — the client's own list-price figure, an estimate.
  Own session only: a line for any other session id is dropped, so a machine
  running two agents reports tokens for the one that bound the port and
  nothing for the other. Absent is absent, never zero. The request carries no
  headers — the bearer token never reaches the port.
- `shyre-hook doctor` prints a `tokens:` line: on, off with the two variables
  to export, or "another exporter — left alone".

## 1.3.0 — 2026-09-05
- `backfill`: reconstruct runs from this machine's Claude Code transcripts
  for sessions before the plugin was installed, and log them like live runs
  — same idle rule, same spool, same coverage check (a window an entry
  already covers is skipped) — marked `backfilled`, which every Shyre view
  badges. Opt-in, per machine, by hand: `node shyre-hook.mjs backfill
  --since=2026-09-01 --dry-run` prints the plan; without `--dry-run` it
  spools and delivers. It reads only the timestamp, the type, whether the line is
  a tool result, the working directory and the session id of each
  transcript line; nothing that was said or written is kept or sent. A
  session still moving — inside the idle cap, or the hooks are writing
  marks for it — is skipped and named in the plan; run it again later.
- The entry body has an eleventh field, `backfilled` (false on live runs).

## 1.2.0 — 2026-09-05
- An undeliverable run waits thirty days, not seven. The prune still counts
  only sweeps that reached a server which answered, so a closed laptop does
  not run the clock down; an outage that outlasted the week was losing the
  week.
- A run is dropped only after the server has been told. The sweep posts the
  drop — window, label, session, key, counts, why; never the working
  directory or the marks, and a repository key only when it is an
  `owner/repo` key rather than a local path — to `POST /api/v1/entries/dropped`,
  and it lands in the token owner's activity list beside the other refusals.
  Only the server's own `{recorded: true}` deletes the file. No answer, a
  redirect, a 401 (a rotated token, or integrations switched off for the
  team — a kill switch holds data, it does not erase it), a 404 from a
  server without the route, a 5xx, a 429, or a sign-in page served as a 200
  all keep the file — until it is ninety days old and three answered reports
  have failed to record it; then it goes with the local log line as its only
  record. A report that never reached a server is not an attempt. A report whose delete then failed is remembered
  on the file, so the drop is never said twice.

## 1.1.0 — 2026-09-05
- The API origin is `https://shyre.io`, the canonical address since
  2026-09-04. The legacy host keeps answering `/api/**` and `/hooks/**`
  unredirected, so a 1.0.2 install keeps landing time.
- `install` never writes the environment's origin into a user's global agent
  config: a `SHYRE_API_URL` set for one shell used to become a permanent
  redirect of the bearer token for every future Codex or Cursor session,
  with nothing printed. A non-default origin is written only with
  `--api-url=<origin>` on the command line, and every install prints the
  origin it wrote. `doctor` warns when the running origin is not the default.
- `install --uninstall <agent>` removes exactly what install added — the hook
  entries, the MCP server, the convention block — and keeps the user's own.
- A rewritten user file keeps its mode, and so does its `.bak`; a 600
  `config.toml` or `mcp.json` no longer comes back 644 with a 644 copy beside
  it. New files the runtime writes into `~/.codex` and `~/.cursor` are 600.
- A payload the runtime cannot read — no session id, not JSON, larger than
  four megabytes — is said in the log once a minute instead of never, and
  `doctor` shows when the last mark was recorded, so a silent install is
  visible before someone notices a missing week.
- `doctor` answers the four questions a broken setup asks: it resolves the
  current directory's repository and repo key, says which map file (if any)
  names it, makes one request to the server to tell a refused token from a
  repo no project names — but not to a non-default origin unless
  `doctor --probe` asks it to — and shows the refusals log's line count and
  last line with any token-shaped text redacted. It prints what it can when
  the home is unwritable.
- A 400 on the first attempt is kept for one retry rather than settled: a
  clock a few minutes fast ("end_time is in the future") and a server behind
  the client (a field it does not know yet) both clear on their own, and the
  run was being deleted over them.
- The seven-day prune applies only to items a sweep that reached the server
  has kept, by the item's own creation time; a sweep with no credential, no
  network or certificate checks off learns nothing and is not a try. A
  session whose flush died with the laptop lid, then a vacation, is delivered
  on the first sweep back, not pruned unattempted. An item with no creation
  stamp (an older runtime's) is capped at twenty tries instead.
- A 429 on the timer read is retried once like the list, so a complete
  coverage list is not thrown away over the token's own minute budget; an
  empty projects list is a failed lookup (kept), not the fact that nothing
  names this repo (settled); a running timer covers a day at most, the
  server's own per-entry maximum; the log says how many seconds under the
  one-minute floor were dropped when a run is stood down.
- `SHYRE_HOOK_LOG` must resolve under the Shyre home, and no field a
  repository controls can put a line break in the log. The detached flush
  cannot crash a hook on a spawn error. The token is not sent to an https
  origin while `NODE_TLS_REJECT_UNAUTHORIZED=0` disables certificate checks.
  `SHYRE_IDLE_CAP_SECONDS` is capped at a day. `origin` is tried first and
  `upstream` second for the repository's remote, for fork-based teams.

- The stand-down is by the minute, across all of your projects. Before
  posting, the runtime lists your entries on every project — paging with
  `until` until it has every entry that starts before the run ends, plus the
  running timer — and posts only the parts of a run no entry already covers,
  with both meters recomputed for each part from the run's own marks. A
  page it cannot fetch, a body that is not a list, or a list still full
  after ten pages is "coverage unknown": the run is posted and the log says
  so. It used to ask one project, one page, and stand the whole run down on
  any overlap, which let a session on a child project be written down twice
  under the parent's entries, and let a short entry inside a long session
  drop the rest of the run. Needs Shyre from 2026-09-04 (the list's `until`).
- A partly delivered run remembers which stretches landed (`done` on the
  spool item) and never posts one twice; a 2xx whose entry is a different
  window than the one posted is treated as the server replaying an earlier
  post, and the stretch is kept for the next sweep.
- A tenth field, `prompt_marks`: the instants you sent a prompt inside the
  run, to the second, at most 2,000 and sampled evenly across the window when
  there are more. Timestamps only, no prompt text. Shyre uses them to suggest
  how an overlap between two sessions splits. A server older than 2026-09-04
  refuses the field; update Shyre first.
- The log-your-time skill and the installed convention gain the rule for
  parallel sessions: they apportion a person's time, they do not each claim
  it.
- Spool items now carry the run's marks locally, so a partly covered run can
  be re-metered. Items written by an older runtime are posted on what they
  have; a partial window of one carries no meters rather than wrong ones.

## 1.0.2 — 2026-09-03

- The runtime is now authored in TypeScript (`hooks/shyre-hook.ts`, shipped
  beside the artifact) and compiled to `hooks/shyre-hook.mjs` by esbuild for
  Node 18; behavior is unchanged. What runs on your machine is still one
  plain JavaScript file with no dependencies.
- The build is checked: the checked-in artifact, the copy the app serves and
  its checksum must all equal the build of the source.

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
