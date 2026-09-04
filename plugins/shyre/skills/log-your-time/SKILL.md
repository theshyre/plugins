---
name: log-your-time
description: Log the time you just spent to Shyre when you finish a substantial unit of work (a shipped PR, a completed feature) in a repository Shyre tracks. Use the Shyre MCP tools or the REST API with the SHYRE_API_KEY bearer token. Covers picking the project and category, the time-window rules, idempotency, and what to do on a 409.
---

# Log your own time to Shyre

The session hooks record every session as a backstop. This skill is the
intent layer: when you finish a unit of work, write the entry yourself, with a
real description and the right category. The hook stands down when your entry
already covers the window, so nothing is counted twice.

**Local override:** if the repo's own `CLAUDE.md` or `AGENTS.md` defines its
own time-logging convention, follow that instead.

## When

At the end of a substantial unit of work: a PR opened or merged, a feature
completed, a review delivered. Not after every small edit.

## How

1. **Find the project.** Call the `list_projects` MCP tool, or
   `GET /api/v1/projects` with `Authorization: Bearer $SHYRE_API_KEY`. Match
   this repo's `origin` remote (owner/repo, case-insensitive) to a project's
   `github_repo`. Read that project's `categories` and pick the best fit
   (development → Engineering; fixes → Bug fix; hygiene → Refactor or Ops).
   If nothing matches, do not guess a project; say so.
2. **Write the entry.** `log_time_entry` (MCP) or `POST /api/v1/entries` with:
   - `project_id`, `category_id` — always pass an explicit category.
   - `start_time` / `end_time` — ISO-8601 **with an offset**. The window is
     ACTIVE work time on THIS unit, never elapsed span. Do not bridge gaps
     over 15 minutes. **`end_time` may never be later than the clock**: read
     the current time first and treat it as the ceiling; if your estimate
     overshoots, shorten the entry rather than sliding `start_time` later.
     Never round `start_time` down to the minute; when logging back to back,
     copy the previous entry's `end_time` verbatim as the new start.
   - `description` — one concise line of outcome, leading with the ticket key
     when there is one.
   - `agent_label` — this agent's name (`Claude Code`, `Codex`, `Cursor`,
     …). Always send it; the label is immutable once written.
   - `session_ref` — this session's id.
   - `idempotency_key` — unique per unit, e.g. `<branch>:<short-slug>`.
     Never the bare branch: two units on one branch would collapse into one.
   - Do **not** set `billable`; the server decides.
3. **On a 409**, read the message: it names the blocking window and the
   earliest free start. Retry once with that start. Do not probe.

## Never

- Log elapsed wall-clock time as work.
- Edit or delete an entry a person logged; the API refuses it anyway.
- Start a timer while one is running; prefer `log_time_entry` after the work.
