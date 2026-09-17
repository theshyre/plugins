# Changelog

All notable changes to the `shyre` plugin. The version is the one in
`plugins/shyre/.claude-plugin/plugin.json`; each release is tagged `v<version>`
here and `plugin-v<version>` in the Shyre repository.

## 1.10.1 — 2026-09-17

Hardening, from an audit of every place the runtime deletes something and a
hostile-input test of the built file (405 malformed payloads: every one exit 0,
under 50 ms — that contract held). What could be lost before, and cannot now:

- **A session that never ended was deleted a week later, unspooled.** Three
  hours of one autonomous turn and a closed terminal — or any host that never
  fires its session-end hook — was three hours gone, with a log line that named
  no minutes. The next sweep now **spools those marks** exactly as a session
  end would, and delivers them. A long session's header, written once, no
  longer makes a live session look stale.
- **A late payload lost the mark.** The hook read its input once; a host that
  wrote it twenty milliseconds late, or in two pieces, got one `EAGAIN` and
  nothing recorded — and a late session-end lost the final stretch. It now
  waits for the payload (up to a second), and accepts one that starts with a
  byte-order mark.
- **A run from an unmapped repository is kept thirty days**, as `doctor`
  always said, instead of being deleted on the first sweep — add the map line a
  week later and the week comes back. After thirty days it is removed with the
  minutes named, and never reported to the server.
- **A refusal that loses time is told to the server in every mode** — post
  mode and backfills too — and kept until recorded. An overlap (`409`) is kept,
  not settled: the server raises it for a *partial* overlap too, so the next
  sweep reads coverage again and posts only the uncovered part; after three
  answered sweeps it is reported like any other loss.
- **A drop report names the repository only when your own map file names
  it.** A run whose project lookup failed cannot be told from an unmapped one,
  and used to be reported with its repository at day thirty.
- **Runs spooled by an older runtime** no longer fall to a twenty-sweep cap
  that a dead token reaches in a day; **a session end that cannot read the
  marks** leaves them; **a checkpoint** no longer throws away marks that
  parallel tool calls appended while it was spooling.
- The hook no longer appends through a symlink (marks or log), records a
  session whose id is too long for a file name, leaves a read-only home
  read-only, and bounds the log (2,000 characters a line, five megabytes a
  file).
- An entry posted after the day's hold says so in its description, and no
  description says "see transcript" any more — a description can reach an
  invoice line. `doctor`'s numbers match the rules, and its two `server:`
  lines are now `version-check:` and `server:`.

## 1.10.0 — 2026-09-17

- **The Claude Code plugin keeps itself current.** Claude Code auto-updates
  only Anthropic's own marketplaces by default, so this plugin sat wherever
  you installed it until you found a toggle three menus deep. Now, when a
  newer release exists, it asks **Claude Code's own updater** to update it
  (`claude plugin marketplace update theshyre`, then `claude plugin update
  shyre@theshyre`) — in the background, at most every six hours, applying at
  your next session, which says so once. It downloads nothing itself and
  trusts no new source. **On by default; off with `SHYRE_HOOK_AUTO_UPDATE=0`
  or `"auto_update": false`, and wherever anyone wrote `autoUpdate: false`
  for the marketplace** (an administrator's managed settings included). A
  failed attempt is recorded and said; `doctor` prints `plugin-update:`.
- **"Too old" keeps your hours.** If Shyre ever refuses this runtime as too
  old (`426`), the run is kept — every earlier runtime deleted it, like any
  other refusal — the next session start says which version is needed, and
  the updated runtime delivers what was kept, for up to ninety days. Shyre
  never sends that answer to a runtime older than this one.
- **A month-old run gets one more delivery before it is called dropped.** The
  sweep used to go straight to the drop report once a run had been kept thirty
  days — so replacing a dead token on day 35 made the first sweep report your
  hours lost and delete them. It now tries to deliver first.
- **Two machines, two lines.** Each install now sends a random id
  (`X-Shyre-Install`, sixteen random bytes kept in `~/.shyre/install-id`) so a
  laptop and a desktop on one account show separately under **Settings →
  Integrations** — a laptop whose hooks stopped is no longer hidden by a
  desktop whose hooks did not. It names nothing about the machine;
  `SHYRE_HOOK_INSTALL_ID=0` sends none. `doctor` prints it.
- **Installer copies keep themselves current.** The copy the installer puts
  at `~/.shyre/bin/shyre-hook.mjs` (Cursor, and Codex without the plugin)
  never updated. It now replaces
  itself, in the background, with the newest release from this repository at
  its version tag, and only when: the Ed25519 signature verifies against a key
  the running copy carries; the signed file is the version named and newer
  than the running one; Node parses it; and it starts. The previous copy is
  kept as `shyre-hook.mjs.prev`. Codex trusts a hook by its definition — the
  event, the matcher and the command string — not by the script behind it
  (run on Codex 0.154: the script was rewritten, the hook still fired), and
  the command never changes, so an update does not ask you to trust anything
  again. One limit, stated plainly: the Codex **VS Code extension** has no
  `/hooks` command, so hooks can only be trusted from the Codex CLI; whether
  the extension then runs them is not something we have been able to confirm.
- **`update`**: `node ~/.shyre/bin/shyre-hook.mjs update` runs the same checks
  now. **`version`** prints the runtime's version.
- **Turn it off** with `SHYRE_HOOK_AUTO_UPDATE=0` or `"auto_update": false` in
  `~/.shyre/config.json`. `doctor` shows the state on its `self-update:` line.
- Every release from this one on ships `shyre-hook.mjs.sig`.

**A copy installed before 1.10.0 cannot update itself.** Re-run the install
once: `curl -fsSL https://shyre.io/hooks/shyre-hook.mjs -o ~/.shyre/bin/shyre-hook.mjs && node ~/.shyre/bin/shyre-hook.mjs install codex` (or `cursor`).

## 1.9.1 — 2026-09-17

- **The day's hold is a delay, not a drop.** 1.9.0 held a stretch with no
  agent entry beside it for a day and then reported it as dropped. For a
  session that ended without logging its unit — or any session on a host whose
  model never logs its own time — that was every minute of it. Now the day
  still gives a parallel session time to log the entry the stretch folds into,
  and what nobody logged by then is **posted as an entry of its own**. Only a
  stretch under two minutes is still reported as dropped. If you are on 1.9.0,
  update within a day of any session you did not log by hand.
- **A refused late entry is said, not swallowed.** When the server refuses
  that entry for good — the period closed in the meantime, above all — the
  hours are lost, and the runtime tells the server so with the stretch's own
  window (`post_refused`), keeping the run until the server has recorded it.
  It shows in your activity list beside the refusal that says why. Needs the
  Shyre server from 2026-09-17 or later (shyre.io already runs it).

## 1.9.0 — 2026-09-16

- **No more "session — active time" entries.** The hook used to post each
  stretch of a session that no entry covered as an entry of its own:
  "Claude Code session — active time (idle gaps excluded); see transcript",
  with no category, often two to six minutes long, and often landing before
  a parallel session logged the work beside it. One day had twelve of them
  among sixteen real entries. Now each stretch **extends the agent entry
  beside it** on the same project (`POST /api/v1/entries/<id>/fold`), and
  its meters — runtime, waiting, prompt instants, and tokens for the same
  model — add to that entry's. The entry keeps its category, description and
  ticket link.
- **A stretch with nothing beside it is held, not posted.** A parallel
  session may log the neighboring entry later, so the run waits up to a day;
  after that it is reported as dropped (`no_entry_to_fold_into`) and shows in
  your activity list. Hand-typed and invoiced entries are never extended.
- **Backfill is unchanged.** `backfill` still posts reconstructed runs as
  entries of their own, marked backfilled — those days usually have nothing
  to extend.
- **The old behavior is one setting away:** `SHYRE_HOOK_MODE=post`, or
  `"hook_mode": "post"` in `~/.shyre/config.json`.

Needs the Shyre server from 2026-09-16 or later (shyre.io already runs it).

## 1.8.0 — 2026-09-16

- **The hooks run in Codex.** Codex installs this plugin from the same
  marketplace (`codex plugin marketplace add theshyre/plugins`, then
  `codex plugin add shyre@theshyre`), but it drops a hook's `args`. Every
  1.7.0 hook ran a bare `node`, which read the hook's payload as a script
  and failed, so a Codex install recorded nothing, with no message. Each
  hook is now one command string,
  `node "${CLAUDE_PLUGIN_ROOT}/hooks/shyre-hook.mjs" claude <event>`, which
  both hosts run. Codex sets `CLAUDE_PLUGIN_ROOT` too, and the runtime reads
  the agent from the payload, so a Codex session is recorded as Codex. A
  test in the Shyre repository now runs every hook command through a shell
  for both hosts' payloads instead of only checking its shape. Codex asks
  you to trust the changed hooks once in `/hooks`.
- **The marketplace owner URL is `https://shyre.io`.** It still named the
  old host.

If you ran `shyre-hook.mjs install codex` before, remove those global hooks
(`node ~/.shyre/bin/shyre-hook.mjs uninstall codex`) when you install the
plugin in Codex, so one set of hooks runs.

## 1.7.0 — 2026-09-10

- **The hook says so after repeated 401s (P-02).** A 401 stays a NON-final
  refusal — a spooled run still has to survive a token rotation without
  being deleted for it — but the runtime now counts consecutive 401 answers
  from delivery in a small file beside the spool, reset on any 2xx. Once the
  streak reaches three, session start prints how many times the token has
  been refused, since when, and where to re-mint it (`/settings/integrations`)
  — and that the spooled runs are kept and will post once a working key is
  in place. `doctor` shows the same streak on its `token:` line. Nothing
  about the server's uniform 401 body or the hook's request shape changed;
  only what the runtime remembers about its own answers.
- **The credentials banner covers agent access tokens too (P-02).** Before
  this, `integration_tokens.expires_at` had zero readers outside the
  function that refuses an expired token with the same 401 as a revoked one
  — a PAT could go quiet with nothing in the app saying why. The dashboard
  banner and `/system/credentials` now list the viewer's own live tokens
  alongside Vercel, Resend, GitHub and Jira, labeled with the token's own
  name and localized in both `en` and `es`.

## 1.6.1 — 2026-09-09

- **The README caught up.** The repository's front page still described
  1.0.2 — no checkpoints, no browser sign-in for the MCP server, no
  auto-update note, the old domain — while five releases went by. It now
  describes the plugin that ships, names the release it belongs to, and a
  test in the Shyre repository refuses a version bump that leaves either
  README untouched. The manifest's homepage is `https://shyre.io`. The
  runtime's behavior is unchanged; only its version string moved.

## 1.6.0 — 2026-09-09

- **Time shows up while you work.** Before this, every run waited for
  session end: a session busy from morning to evening wrote nothing to Shyre
  all day, and a session left open overnight wrote nothing at all. Now a
  `stop` beat — the agent finished its turn — with more than
  `checkpoint_seconds` (default 1800, half an hour) of unposted work posts
  that stretch as its own entry, cut at that mark, and a beat that arrives
  after a gap over the idle cap posts the run before it at once. Session end
  is unchanged: it posts whatever the marks file still holds. A long session
  becomes several entries instead of one; each has its true window and both
  meters, and the stand-down still works by the minute against your own
  entries — so an entry you log yourself for a unit of work may be answered
  with a 409: retry once with the earliest free start it names, or, when it
  says the window is already covered, leave it (the checkpoint has it). The
  half-hour is measured on the OPEN run, so the first stop after a break is
  not a cut. A tail under a minute at session end is dropped, as any run
  under a minute always was; the token meter then rides the newest
  undelivered checkpoint. `SHYRE_CHECKPOINT_SECONDS=0` or
  `"checkpoint_seconds": 0` in `~/.shyre/config.json` turns both cuts off.
- **The plugin says when it is stale.** Auto-update is off by default for
  every third-party marketplace, and nothing a marketplace ships can turn it
  on, so a plugin that was installed by hand sat at 1.0.2 while five
  releases went by. Each sweep now asks the server which runtime it serves
  (`GET /hooks/VERSION`, no token) and remembers the answer; the next session
  start compares it — and the marketplace clone's manifest — to the running
  copy, and when either is newer prints one line into the agent's context
  naming the version and the two ways forward: `/plugin update shyre@theshyre`
  now, or `/plugin → Marketplaces → theshyre → Enable auto-update` once.
  A Codex or Cursor install is told the `curl` re-install instead. And the
  plugin now checks whether auto-update is ON for the theshyre marketplace
  on this machine — the `/plugin` toggle's entry in `known_marketplaces.json`,
  then managed, project and user settings — and when it is off, a session start says
  so and how to turn it on, at most once a day. `doctor` prints
  `auto-update:`, `latest:` and `checkpoints:` lines.
- **A run mapped to an archived project is kept, not posted**, with the
  reason in the log, until the map or the project changes; a run mapped to a
  completed project is posted (a delivered fixed-bid gets warranty sessions)
  and the log says so each time, because the map file's own note warns about
  a repo still pointed at a deliverable that finished while the work moved
  on. The projects list now carries each project's status for this.
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
