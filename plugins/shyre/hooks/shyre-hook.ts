// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Malcom IO LLC. Licensed under the MIT License; see the
// LICENSE file published with this plugin at https://github.com/theshyre/plugins.

/*!
 * Shyre agent-session logger — ONE runtime for every coding agent.
 *
 * Two files, one program: `shyre-hook.ts` is the source, and `shyre-hook.mjs`
 * is its build (scripts/sync-hooks-runtime.mjs: esbuild, target Node 18, no
 * dependencies), checked in beside it because a hook has to run as a bare
 * `node` command on whatever machine the plugin lands on, and plugin installs
 * copy files rather than build them. Changes go in the .ts; the .mjs is
 * regenerated from it, never edited.
 *
 * Runs on the agent's lifecycle hooks and records a time entry for each run
 * of activity in a session. Plain Node (18+), the same file on macOS, Linux
 * and Windows, shipped inside the Claude Code plugin and installed for other
 * agents by `install <agent>`.
 *
 *   node shyre-hook.mjs <agent> start            SessionStart
 *   node shyre-hook.mjs <agent> beat <tag>       tool | stop | prompt
 *   node shyre-hook.mjs <agent> end              SessionEnd
 *   node shyre-hook.mjs flush                    deliver whatever is spooled
 *   node shyre-hook.mjs install <agent>          write that agent's config
 *   node shyre-hook.mjs doctor                   print what it can see
 *
 * The hook payload (JSON) arrives on stdin. Never blocks and never fails a
 * session: every hook path swallows its own errors and exits 0.
 *
 * WHAT THIS FIXES, AND WHY EACH ONE IS SHAPED AS IT IS.
 *
 * • Compaction no longer discards the session. Claude Code fires SessionStart
 *   again after context compaction with the SAME session id; the shell kit's
 *   `start` truncated the state file, so everything before the compaction was
 *   thrown away (a 13-hour session logged 91 minutes). `start` here APPENDS a
 *   mark when state already exists.
 *
 * • One entry per RUN of activity, with real timestamps — split only where
 *   your own entries already cover part of it. The shell kit posted
 *   `[session start, session start + active]`, which for a multi-day session
 *   fabricated one contiguous window on day one. A run is a stretch of marks
 *   with no gap over the idle cap; each run becomes an entry with its true
 *   start and end, or one entry per uncovered stretch of it. Nothing is
 *   bridged, nothing is invented.
 *
 * • SessionEnd does no network. Claude Code gives SessionEnd hooks 1.5 s
 *   shared; Codex gives 1 s and ignores `async`. `end` writes spool files and
 *   returns; a detached `flush` delivers them, and the next `start` sweeps
 *   whatever that attempt could not land. State lives under ~/.shyre, not
 *   $TMPDIR, so a reboot does not empty the spool.
 *
 * • A refusal, a stand-down and an unmapped repo are all written to
 *   ~/.shyre/refusals.log with the server's reason. Nothing is discarded in
 *   silence.
 *
 * • An overlap refusal that names an earliest free start is retried ONCE with
 *   the window trimmed to it — the fix the server attaches to the 409.
 *
 * • The repo → project map is looked up case-insensitively, then falls back to
 *   the server: `GET /api/v1/projects` returns each project's `github_repo`,
 *   so a repo whose project names it needs no local map line at all.
 *
 * • Both meters (agent_runtime_min / agent_wait_min) are computed from the
 *   beat tags: a gap that STARTS at `stop` is the agent waiting on the human;
 *   any other gap is the machine working. runtime + wait == active, exactly.
 *
 * • The stand-down is by the MINUTE, across ALL of your projects. Before
 *   posting, the runtime lists your entries on every project — paging with
 *   `until` until it has every entry that starts before the run ends, plus
 *   the running timer — and posts only the parts of the run no entry already
 *   covers, with the meters recomputed for each part from the run's own
 *   marks. A page that cannot be fetched, a body that is not a list, or a
 *   list still truncated after ten pages is "coverage unknown": the run is
 *   posted and the log says so. The first cut asked one project, one page,
 *   and stood the whole run down on any overlap: a hook entry on the child
 *   project landed under the agent's own entries on the parent, and one
 *   afternoon was written down twice under two names.
 *
 * • A partly delivered run remembers what landed. Each settled stretch's
 *   start is written back to the spool item (`done`), so a later sweep never
 *   re-posts it — and never posts the whole window under the first stretch's
 *   key, which the server would answer with that stretch as an idempotent
 *   replay and the rest of the run would be lost. A 2xx whose entry has a
 *   different window than the one posted is treated as exactly that replay
 *   and the stretch is kept.
 *
 * • The tenth field: prompt_marks, the instants you sent a prompt inside the
 *   run. Timestamps only — no prompt text, no diff, no file names. The day
 *   view uses them to suggest how an overlap between two sessions splits.
 */

import { spawn, execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VERSION = "1.5.0";

/** Agent id → what the entry's `agent_label` says. */
export const AGENT_LABELS = Object.freeze({
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  copilot: "Copilot CLI",
  opencode: "OpenCode",
} as const);

export type Agent = keyof typeof AGENT_LABELS;

export function isAgent(value: string): value is Agent {
  return Object.prototype.hasOwnProperty.call(AGENT_LABELS, value);
}

/** The label for an agent id, or the id itself when it is not one we know. */
function labelFor(agent: string): string {
  return isAgent(agent) ? AGENT_LABELS[agent] : agent;
}

/** One hook event and the runtime arguments it invokes. */
export type Wiring = readonly (readonly [event: string, args: string])[];

/**
 * Every hook event each agent wires, and the tag the runtime receives for it.
 * `start` and `end` are lifecycle; the rest are beats. This table is what the
 * Claude plugin's hooks.json and every installer are generated from, so one
 * agent cannot drift from another (the PowerShell port once wired only Stop).
 */
export const HOOK_WIRING: Readonly<Record<"claude" | "codex" | "cursor", Wiring>> = Object.freeze({
  claude: [
    ["SessionStart", "start"],
    ["UserPromptSubmit", "beat prompt"],
    ["PostToolUse", "beat tool"],
    ["SubagentStop", "beat tool"],
    ["Stop", "beat stop"],
    ["SessionEnd", "end"],
  ],
  codex: [
    ["SessionStart", "start"],
    ["UserPromptSubmit", "beat prompt"],
    ["PostToolUse", "beat tool"],
    ["SubagentStop", "beat tool"],
    ["Stop", "beat stop"],
    ["SessionEnd", "end"],
  ],
  cursor: [
    ["sessionStart", "start"],
    ["beforeSubmitPrompt", "beat prompt"],
    ["postToolUse", "beat tool"],
    ["subagentStop", "beat tool"],
    ["stop", "beat stop"],
    ["sessionEnd", "end"],
  ],
});

export interface Mark {
  t: number;
  k: string;
}

export interface Run {
  start: string;
  end: string;
  runtimeMin: number;
  waitMin: number;
  index: number;
  /** The run's own marks, kept so a partly covered run can be re-metered. */
  marks: Mark[];
}

export interface Meta {
  agent: string;
  label: string;
  session: string;
  cwd: string;
  repoKey: string | null;
}

export interface Config {
  apiKey: string;
  apiUrl: string;
  idleCapSeconds: number;
}

/** One queued run, as written to ~/.shyre/spool. */
export interface SpoolItem {
  agent: string;
  label: string;
  session: string;
  cwd: string;
  repo_key: string | null;
  start_time: string;
  end_time: string;
  /** Absent (not zero) when the item was written without meters. */
  agent_runtime_min: number | undefined;
  agent_wait_min: number | undefined;
  idempotency_key: string;
  session_ref: string;
  /** The third meter, scraped from the agent's own exporter at session end
   *  and attached to the LAST run of the session (the counters are
   *  cumulative for the process; there is no honest way to apportion them
   *  across runs, so the run that ends the session carries them). Absent
   *  when the exporter was off, another session held the port, or the scrape
   *  named a different session — never zero. */
  agent_tokens?: AgentTokens | undefined;
  created?: string;
  /** Sweeps that reached the server about this item and kept it. */
  tries?: number;
  /** Drop reports that reached a server which answered and did not record
   *  the drop. Gates the give-up the way `tries` gates the prune: a report
   *  that never reached anyone is not an attempt. */
  drop_attempts?: number;
  /** In memory only: this sweep got an answer from the server about this item. */
  contacted?: boolean;
  /** Reconstructed after the fact by `backfill` from local session history,
   *  not recorded live. Sent as the eleventh field; the server badges it. */
  backfilled?: boolean;
  /** The run's marks, LOCAL ONLY: never sent as such. Absent on items an
   *  older runtime wrote; such an item is posted on what it has. */
  marks?: Mark[];
  /** The stretches of this run that already settled — posted, or refused
   *  for good — as `start|end`, written back by the flush so a later sweep
   *  skips exactly them. A longer stretch from the same start is a different
   *  stretch. */
  done?: string[];
}

/** What the exporter said about THIS session, and nothing about the account
 *  it belongs to. The scrape also carries the account email, the organization
 *  id and the user id; those never leave the machine. */
export interface AgentTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  /** The model that spent the most of them. A session that used several
   *  reports the dominant one and its counts — tokens are per model, and a
   *  sum across models is a number with no unit. */
  model: string;
  /** The client's list-price valuation for the whole session, all models. An
   *  estimate, never an expense: a Max subscriber's payable is zero. */
  cost_usd_list: number;
}

export interface EntryBodyInput {
  project_id: string;
  label: string;
  start_time: string;
  end_time: string;
  session_ref: string;
  idempotency_key: string;
  agent_runtime_min?: number | undefined;
  agent_wait_min?: number | undefined;
  prompt_marks?: string[] | undefined;
  backfilled?: boolean | undefined;
  agent_tokens?: AgentTokens | undefined;
}

/** The fourteen fields the server receives, and nothing else. */
export interface EntryBody {
  project_id: string;
  start_time: string;
  end_time: string;
  description: string;
  agent_label: string;
  session_ref: string;
  idempotency_key: string;
  agent_runtime_min: number | undefined;
  agent_wait_min: number | undefined;
  /** Instants a prompt was sent inside the window. Absent when the item
   *  carries no marks (an older spool item), never invented. */
  prompt_marks: string[] | undefined;
  /** The eleventh field: true only for entries `backfill` reconstructed. */
  backfilled: boolean;
  /** Twelve to fourteen: the third meter. Counts by type as the exporter
   *  labels them; the model; the list-price figure. Absent, never zero, when
   *  the session reported nothing. */
  agent_tokens: { input: number; output: number; cache_read: number; cache_creation: number } | undefined;
  agent_model: string | undefined;
  agent_cost_usd_list: number | undefined;
}

type Env = Record<string, string | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** A day: no run may be longer than the server's per-entry maximum anyway. */
export const MAX_IDLE_CAP_SECONDS = 86_400;

export function shyreHome(): string {
  return process.env.SHYRE_HOME || join(homedir(), ".shyre");
}

export const DEFAULT_API_URL = "https://shyre.io";

/**
 * The API origin is written into the user's MCP configs and receives the
 * bearer token, so it is validated before either: https only (plain http on
 * localhost for development), a parseable URL, no credentials, no path, and
 * nothing outside the URL character set that would break a TOML string.
 * Anything else falls back to the default.
 */
export function validApiUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (!/^[A-Za-z0-9.:/-]+$/.test(url.origin)) return null;
  return url.origin;
}

/**
 * Token and URL: the environment first, then ~/.shyre/config.json. The file
 * exists for shells that do not export the variable, and because a token in
 * a 600 file is no worse than a token in a shell profile.
 */
export function readConfig(env: Env = process.env): Config {
  let file: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(shyreHome(), "config.json"), "utf8"));
    if (isRecord(parsed)) file = parsed;
  } catch {
    file = {};
  }
  const fileKey = typeof file.api_key === "string" ? file.api_key : "";
  const fileUrl = typeof file.api_url === "string" ? file.api_url : undefined;
  const fileCap = typeof file.idle_cap_seconds === "number" || typeof file.idle_cap_seconds === "string" ? file.idle_cap_seconds : undefined;
  const apiKey = env.SHYRE_API_KEY || fileKey;
  const apiUrl = validApiUrl(env.SHYRE_API_URL || fileUrl) || DEFAULT_API_URL;
  const cap = Number(env.SHYRE_IDLE_CAP_SECONDS || fileCap || 900);
  // Bounded above as well as below: a cap of 1e9 would turn elapsed span
  // into "active time", which is the one thing the meter must never do.
  return { apiKey, apiUrl, idleCapSeconds: Number.isFinite(cap) && cap > 0 && cap <= MAX_IDLE_CAP_SECONDS ? cap : 900 };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * `git@github.com:Owner/Repo.git` / `https://github.com/owner/repo/` →
 * `owner/repo`. Lower-cased: GitHub is case-insensitive and the remote's
 * casing is whatever was cloned (a `Malcom-IO/quillquest` remote missed a
 * `malcom-io/quillquest` map line for weeks).
 */
export function repoKeyFromRemote(remote: unknown): string | null {
  if (!remote) return null;
  const key = String(remote)
    .replace(/[\r\n\t]+/g, "")
    .trim()
    .replace(/^[a-z+]+:\/\/[^/]+\//i, "")
    .replace(/^[^@]+@[^:]+:/, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  return key ? key.toLowerCase() : null;
}

export interface NormalizedPayload {
  session: string | null;
  cwd: string;
  source: string | null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

/**
 * The hook payload differs per agent. Claude/Codex/Gemini: `session_id` +
 * `cwd`; Cursor: `conversation_id` + `workspace_roots[0]`; Copilot:
 * `sessionId`; OpenCode: `sessionID` + `directory`.
 */
export function normalizePayload(raw: unknown, env: Env = process.env): NormalizedPayload {
  const p = isRecord(raw) ? raw : {};
  const session = firstString(p, ["session_id", "sessionId", "conversation_id", "sessionID", "session"]);
  const roots = Array.isArray(p.workspace_roots) ? p.workspace_roots : [];
  const firstRoot = typeof roots[0] === "string" ? roots[0] : null;
  const cwd = firstString(p, ["cwd", "directory"]) || firstRoot || env.CURSOR_PROJECT_DIR || process.cwd();
  return { session, cwd: String(cwd), source: firstString(p, ["source", "reason"]) };
}

/**
 * Which agent is REALLY running us. Cursor loads Claude Code plugins too
 * (it reads ~/.claude/plugins and expands ${CLAUDE_PLUGIN_ROOT}), so in a
 * Cursor session the Claude plugin's hooks fire alongside Cursor's own — the
 * same event twice, once as `claude`, once as `cursor`. Trusting argv would
 * label Cursor's time "Claude Code" and race two state files. The payload
 * carries the truth: Cursor sends `cursor_version` / `conversation_id` /
 * `workspace_roots`; Codex's transcript lives under `.codex/`; Copilot's
 * payload is camelCase (`sessionId`). Detecting from evidence keys both
 * invocations to ONE state file, so the second `end` finds nothing to do.
 */
export function detectAgent(argvAgent: string, raw: unknown): Agent {
  const p = isRecord(raw) ? raw : {};
  if (p.cursor_version !== undefined || p.conversation_id !== undefined || Array.isArray(p.workspace_roots)) {
    return "cursor";
  }
  const transcript = typeof p.transcript_path === "string" ? p.transcript_path : "";
  if (/[\\/]\.codex[\\/]/.test(transcript)) return "codex";
  if (/[\\/]\.claude[\\/]/.test(transcript)) return "claude";
  if (p.sessionId !== undefined && p.session_id === undefined) return "copilot";
  if (p.sessionID !== undefined && p.directory !== undefined) return "opencode";
  return isAgent(argvAgent) ? argvAgent : "claude";
}

/** Parse a marks file: one `ISO tag` per line; blank or malformed lines dropped. */
export function parseMarks(text: string): Mark[] {
  const out: Mark[] = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(\S+)(?:\s+(\S+))?\s*$/.exec(line);
    if (!m || m[1] === undefined) continue;
    const t = Date.parse(m[1]);
    if (!Number.isFinite(t)) continue;
    out.push({ t, k: m[2] || "tool" });
  }
  return out;
}

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Split marks into runs at gaps over the idle cap, and compute the meters
 * per run. A run under 60 s of activity is dropped. A gap is charged to
 * `wait` when it STARTS at a `stop` mark (the agent had finished its turn and
 * was blocked on the human) and to `runtime` otherwise. Runs longer than
 * 23 h are cut so no entry can exceed the server's 24 h maximum.
 */
export function segmentRuns(marks: readonly Mark[], capSeconds: number): Run[] {
  const sorted = [...marks].sort((a, b) => a.t - b.t);
  const runs: Run[] = [];
  const capMs = capSeconds * 1000;
  const maxRunMs = 23 * 3600 * 1000;
  let i = 0;
  while (i < sorted.length) {
    const first = sorted[i];
    if (!first) break;
    let j = i;
    let last = first;
    let runtime = 0;
    let wait = 0;
    for (;;) {
      const next = sorted[j + 1];
      if (!next) break;
      const gap = next.t - last.t;
      if (gap > capMs) break;
      if (next.t - first.t > maxRunMs) break;
      // Split by what the gap STARTS from: a gap after `stop` is the agent
      // waiting on the human; anything else is the machine working.
      if (last.k === "stop") wait += gap;
      else runtime += gap;
      j += 1;
      last = next;
    }
    const active = runtime + wait;
    if (active >= 60 * 1000) {
      runs.push({
        start: isoSeconds(first.t),
        end: isoSeconds(last.t),
        runtimeMin: Math.floor(runtime / 60000),
        waitMin: Math.floor(wait / 60000),
        index: runs.length + 1,
        marks: sorted.slice(i, j + 1),
      });
    }
    i = j + 1;
  }
  return runs;
}

/** The eleven fields the server receives, and nothing else. */
export function buildEntryBody(item: EntryBodyInput): EntryBody {
  return {
    project_id: item.project_id,
    start_time: item.start_time,
    end_time: item.end_time,
    description: item.backfilled
      ? `${item.label} session — backfilled from local history after the fact; active time (idle gaps excluded)`
      : `${item.label} session — active time (idle gaps excluded); see transcript`,
    agent_label: item.label,
    session_ref: item.session_ref,
    idempotency_key: item.idempotency_key,
    agent_runtime_min: item.agent_runtime_min,
    agent_wait_min: item.agent_wait_min,
    prompt_marks: item.prompt_marks,
    backfilled: item.backfilled === true,
    agent_tokens: item.agent_tokens
      ? { input: item.agent_tokens.input, output: item.agent_tokens.output, cache_read: item.agent_tokens.cache_read, cache_creation: item.agent_tokens.cache_creation }
      : undefined,
    agent_model: item.agent_tokens?.model,
    agent_cost_usd_list: item.agent_tokens?.cost_usd_list,
  };
}

/** A half-open window as a pair of ISO instants (seconds precision). */
export type Segment = readonly [start: string, end: string];

/**
 * The parts of [start, end) that NO existing entry covers, each at least a
 * minute long. Mirrors the server's overlap predicate — strict inequalities,
 * so touching windows are legal, and a running timer (`end_time` null) reads
 * as open through now — but answers by the minute rather than yes/no: a run
 * partly covered by your own per-unit entry posts its uncovered remainder,
 * never the whole run and never nothing. An entry with an unparseable date is
 * skipped; the server's guard is the backstop.
 */
export function uncoveredSegments(entries: unknown, start: string, end: string, nowIso: string = new Date().toISOString()): Segment[] {
  const ws = Date.parse(start);
  const we = Date.parse(end);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(ws) || !Number.isFinite(we) || we <= ws) return [];
  const covered: Array<[number, number]> = [];
  if (Array.isArray(entries)) {
    for (const e of entries as unknown[]) {
      if (!isRecord(e)) continue;
      const s = typeof e.start_time === "string" ? Date.parse(e.start_time) : Number.NaN;
      // A running timer is open through now — but the server refuses any
      // entry over 24 h, so a timer left running for days can never become an
      // entry covering those days; it covers a day at most.
      const en = typeof e.end_time === "string" ? Date.parse(e.end_time) : e.end_time ? Number.NaN : Math.min(now, s + 86_400_000);
      if (Number.isFinite(s) && Number.isFinite(en) && s < we && en > ws) covered.push([Math.max(s, ws), Math.min(en, we)]);
    }
  }
  covered.sort((a, b) => a[0] - b[0]);
  const out: Segment[] = [];
  let cursor = ws;
  for (const [s, en] of covered) {
    if (s > cursor && s - cursor >= 60000) out.push([isoSeconds(cursor), isoSeconds(s)]);
    cursor = Math.max(cursor, en);
  }
  if (we > cursor && we - cursor >= 60000) out.push([isoSeconds(cursor), isoSeconds(we)]);
  return out;
}

/** Milliseconds of [start, end) no entry covers, floor or no floor — for saying what was dropped. */
export function uncoveredMillis(entries: unknown, start: string, end: string, nowIso: string = new Date().toISOString()): number {
  const ws = Date.parse(start);
  const we = Date.parse(end);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(ws) || !Number.isFinite(we) || we <= ws) return 0;
  const covered: Array<[number, number]> = [];
  if (Array.isArray(entries)) {
    for (const e of entries as unknown[]) {
      if (!isRecord(e)) continue;
      const s = typeof e.start_time === "string" ? Date.parse(e.start_time) : Number.NaN;
      const en = typeof e.end_time === "string" ? Date.parse(e.end_time) : e.end_time ? Number.NaN : Math.min(now, s + 86_400_000);
      if (Number.isFinite(s) && Number.isFinite(en) && s < we && en > ws) covered.push([Math.max(s, ws), Math.min(en, we)]);
    }
  }
  covered.sort((a, b) => a[0] - b[0]);
  let cursor = ws;
  let uncovered = 0;
  for (const [s, en] of covered) {
    if (s > cursor) uncovered += s - cursor;
    cursor = Math.max(cursor, en);
  }
  if (we > cursor) uncovered += we - cursor;
  return uncovered;
}

/**
 * The two meters for one window of a run, from the run's own marks: each
 * gap between consecutive marks is clipped to the window and charged to
 * `wait` when it starts at `stop`, to `runtime` otherwise — the same rule as
 * segmentRuns, so on the whole run the two agree exactly.
 */
export function metersFor(marks: readonly Mark[], start: string, end: string): { runtimeMin: number; waitMin: number } {
  const ws = Date.parse(start);
  const we = Date.parse(end);
  const sorted = [...marks].sort((a, b) => a.t - b.t);
  let runtime = 0;
  let wait = 0;
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (!a || !b) break;
    const from = Math.max(a.t, ws);
    const to = Math.min(b.t, we);
    if (to <= from) continue;
    if (a.k === "stop") wait += to - from;
    else runtime += to - from;
  }
  return { runtimeMin: Math.floor(runtime / 60000), waitMin: Math.floor(wait / 60000) };
}

/** The server refuses a longer list — and drops the field, not the entry —
 *  so the runtime sends at most this many. */
export const PROMPT_MARKS_MAX = 2000;

/**
 * The prompt instants inside [start, end], as ISO seconds, ascending,
 * de-duplicated to the second, at most PROMPT_MARKS_MAX of them. Over the
 * cap the list is SAMPLED EVENLY, first and last kept: the marks exist so a
 * resolver can see where in the window the prompts fell, and the earliest
 * two thousand of a long run would all sit at its start and say the
 * opposite of the truth.
 */
export function promptMarksFor(marks: readonly Mark[], start: string, end: string): string[] {
  const ws = Date.parse(start);
  const we = Date.parse(end);
  const seconds = [...new Set(marks.filter((m) => m.k === "prompt" && m.t >= ws && m.t <= we).map((m) => Math.floor(m.t / 1000) * 1000))].sort((a, b) => a - b);
  if (seconds.length <= PROMPT_MARKS_MAX) return seconds.map((t) => isoSeconds(t));
  const out: string[] = [];
  const last = seconds.length - 1;
  for (let i = 0; i < PROMPT_MARKS_MAX; i += 1) {
    const idx = Math.round((i * last) / (PROMPT_MARKS_MAX - 1));
    const t = seconds[idx];
    if (t !== undefined) out.push(isoSeconds(t));
  }
  return out;
}

/** The ISO instant an overlap refusal names as the earliest legal start, if any. */
export function earliestFreeStart(message: unknown): string | null {
  const m = /earliest free start is (\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/i.exec(String(message ?? ""));
  return m && m[1] !== undefined ? m[1] : null;
}

/** Case-insensitive lookup of a repo key in a map object, else `_default`. */
export function resolveFromMap(map: unknown, repoKey: string | null): string | null {
  if (!isRecord(map)) return null;
  if (repoKey) {
    for (const [k, v] of Object.entries(map)) {
      if (k.startsWith("_")) continue;
      if (k.toLowerCase() === repoKey && typeof v === "string" && v) return v;
    }
  }
  const fallback = map._default;
  return typeof fallback === "string" && fallback ? fallback : null;
}

// ---------------------------------------------------------------------------
// Local files
// ---------------------------------------------------------------------------

function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

/** Our own state directories: the marks and spool name projects, working
 *  windows and absolute paths, and config.json may hold the token. 0700. */
function ensurePrivateDir(p: string): string {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  try {
    chmodSync(p, 0o700);
  } catch {
    /* not every filesystem honors modes */
  }
  return p;
}

/** The mode a file has, or undefined when there is no file. */
function modeOf(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

/**
 * Write through a temp file and rename. The rename would otherwise replace
 * the target's mode with the umask default: a 600 config rewritten as 644
 * (SAL-177 in the Shyre repo). So the existing mode is kept unless one is
 * given.
 */
function writeAtomic(path: string, text: string, mode?: number): void {
  const keep = mode ?? modeOf(path);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, keep === undefined ? undefined : { mode: keep });
  renameSync(tmp, path);
}

/**
 * Rewrite a file the USER owns: keep what was there. The first backup is the
 * pristine original and is never overwritten; later ones are timestamped, so
 * a second install cannot replace the original with its own first output.
 */
function writeUserFile(path: string, text: string, defaultMode = 0o600): void {
  const mode = modeOf(path) ?? defaultMode;
  if (existsSync(path)) {
    try {
      // The backup carries the original's mode: a 600 file's copy is 600.
      const bak = existsSync(`${path}.bak`) ? `${path}.bak.${Date.now()}` : `${path}.bak`;
      writeFileSync(bak, readFileSync(path), { mode });
    } catch {
      /* a backup we could not take is not a reason to refuse the write */
    }
  }
  writeAtomic(path, text, mode);
}

function sessionsDir(): string {
  ensurePrivateDir(shyreHome());
  return ensurePrivateDir(join(shyreHome(), "sessions"));
}

function spoolDir(): string {
  ensurePrivateDir(shyreHome());
  return ensurePrivateDir(join(shyreHome(), "spool"));
}

function stateBase(agent: string, session: string): string {
  const safe = String(session).replace(/[^A-Za-z0-9._-]/g, "_");
  return join(sessionsDir(), `${agent}-${safe}`);
}

/**
 * Where the log may go: under the Shyre home, and nowhere else. An arbitrary
 * path would make the hook a way to append a line to any file the user can
 * write, with the fields a repository controls (its remote, its directory)
 * in it. Anything outside falls back to the default.
 */
export function refusalLogPath(env: Env = process.env): string {
  const fallback = join(shyreHome(), "refusals.log");
  const raw = env.SHYRE_HOOK_LOG;
  if (!raw) return fallback;
  const home = resolve(shyreHome());
  const target = resolve(raw);
  return target.startsWith(`${home}${sep}`) ? target : fallback;
}

export function logRefusal(line: string): void {
  try {
    const target = refusalLogPath();
    ensureDir(join(target, ".."));
    // One record per line: a field a repository controls (its remote, its
    // directory, the server's text) cannot forge a second line.
    const flat = line.replace(/[\r\n]+/g, " ");
    appendFileSync(target, `${new Date().toISOString()}\t${flat}\n`);
    try {
      chmodSync(target, 0o600);
    } catch {
      /* not every filesystem honors modes */
    }
  } catch {
    /* logging must never throw */
  }
}

/**
 * Say something at most once a minute per subject. A hook that receives a
 * payload it cannot read fires on every tool call; one line a minute is
 * enough to notice, a line per call would bury the log.
 */
function noteOncePerMinute(subject: string, line: string): void {
  try {
    const marker = join(ensurePrivateDir(shyreHome()), `.said-${subject}`);
    const last = modeOf(marker) === undefined ? 0 : statSync(marker).mtimeMs;
    if (Date.now() - last < 60_000) return;
    writeFileSync(marker, "", { mode: 0o600 });
    logRefusal(line);
  } catch {
    /* saying it is best effort */
  }
}

/** The keys a payload carried, for the note when none of them names a session. */
function payloadKeys(raw: unknown): string {
  return isRecord(raw) ? Object.keys(raw).slice(0, 12).join(",") || "(none)" : typeof raw;
}

/**
 * The origin remote of the repository that contains `cwd`, or null. The
 * lookup is by DIRECTORY, so an inherited GIT_DIR / GIT_WORK_TREE is
 * dropped from git's environment: a hook fired from inside another git
 * process (a pre-push hook, a rebase, an editor's git integration) inherits
 * those, and with GIT_DIR set every directory on the machine resolves to
 * that one repository — a session in a plain folder would be recorded
 * against whatever repo the parent process was operating on.
 */
export function gitRemote(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete clean[k];
  // `origin` first; `upstream` when there is no origin. A fork-based team
  // clones its own fork as origin and adds the shared repo as upstream, and
  // a session there is work on the shared project, not the fork.
  for (const name of ["origin", "upstream"]) {
    try {
      // ⚠️ `remote get-url` touches no index, no tty and no network, so a
      // hostile .git/config (core.fsmonitor, hooks, pagers, credential
      // helpers) runs nothing — verified 2026-09-05 against a repo wiring
      // every such key to a marker script. That guarantee is the choice of
      // subcommand; never grow it into one that refreshes the index or dials
      // out. fsmonitor is cleared and prompts are refused as standing guards.
      const url = execFileSync("git", ["-c", "core.fsmonitor=", "-C", cwd, "remote", "get-url", name], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        env: { ...clean, GIT_TERMINAL_PROMPT: "0" },
      }).trim();
      if (url) return url;
    } catch {
      /* try the next name */
    }
  }
  return null;
}

/** The map files, in the order they are consulted. */
export function mapFileCandidates(): string[] {
  return [join(shyreHome(), "projects.json"), join(homedir(), ".claude", "shyre-projects.json")];
}

function readMapFile(): unknown {
  return readMapFileFrom()?.map ?? null;
}

/** The first readable map file and its contents, so doctor can name it. */
function readMapFileFrom(): { path: string; map: unknown } | null {
  for (const candidate of mapFileCandidates()) {
    try {
      return { path: candidate, map: JSON.parse(readFileSync(candidate, "utf8")) as unknown };
    } catch {
      /* try the next */
    }
  }
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  json: unknown;
  text: string;
}

interface HttpOptions {
  apiKey: string;
  agent: string;
  session: string;
  body?: unknown;
}

async function http(method: "GET" | "POST", url: string, { apiKey, agent, session, body }: HttpOptions): Promise<HttpResult> {
  // A corporate proxy setup that disables certificate checks globally would
  // have the hook hand the token to whatever presents a certificate.
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" && url.startsWith("https:")) {
    return { status: 0, json: null, text: "refusing to send the token while NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate checks" };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(url, {
      method,
      signal: ctl.signal,
      // Never follow: a same-origin 307 to /login (a proxy in front of the
      // API, a captive portal) would otherwise come back as an HTML 200 and
      // read as a successful post. A 3xx is returned as itself and kept.
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Agent-Label": labelFor(agent),
        "X-Session-Ref": session,
        "User-Agent": `shyre-hook/${VERSION}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  } catch (err) {
    return { status: 0, json: null, text: errorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function nowIso(): string {
  return isoSeconds(Date.now());
}

/** More than this is not a hook payload; the runtime needs a session id and a directory. */
export const STDIN_MAX_BYTES = 4 * 1024 * 1024;

function readStdin(): unknown {
  try {
    if (process.stdin.isTTY) return {};
    const text = readFileSync(0, "utf8");
    if (text.length > STDIN_MAX_BYTES) {
      noteOncePerMinute("stdin-size", `payload of ${text.length} bytes ignored: larger than ${STDIN_MAX_BYTES}`);
      return {};
    }
    return text.trim() ? (JSON.parse(text) as unknown) : {};
  } catch (err) {
    noteOncePerMinute("stdin-json", `payload was not JSON, nothing recorded: ${errorMessage(err).slice(0, 120)}`);
    return {};
  }
}

function detachedFlush(): void {
  // Tests run the lifecycle against a temporary home; a real child here
  // would inherit the developer's token and post fixtures at production.
  if (process.env.SHYRE_NO_DETACH === "1") return;
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "flush"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    // EAGAIN under a heavy build, EPERM under a hardened profile, ENOENT after
    // a node upgrade mid-session: delivered as an event, and an unhandled one
    // is the one path out of "the hook never fails a session".
    child.on("error", () => {
      /* the spool is the durable record; a lost flush is retried next start */
    });
    child.unref();
  } catch {
    /* the spool is the durable record; a lost flush is retried next start */
  }
}

/** SessionStart. Appends when state already exists — compaction, resume. */
export function cmdStart(argvAgent: string, payload: unknown): void {
  const agent = detectAgent(argvAgent, payload);
  const { session, cwd } = normalizePayload(payload);
  if (!session) {
    noteOncePerMinute("no-session", `${agent}\tstart payload names no session, nothing recorded; keys: ${payloadKeys(payload)}`);
    return;
  }
  const base = stateBase(agent, session);
  if (!existsSync(`${base}.meta.json`)) {
    const meta: Meta = {
      agent,
      label: AGENT_LABELS[agent],
      session,
      cwd,
      repoKey: repoKeyFromRemote(gitRemote(cwd)),
    };
    writeAtomic(`${base}.meta.json`, JSON.stringify(meta), 0o600);
  }
  appendFileSync(`${base}.marks`, `${nowIso()} start\n`, { mode: 0o600 });
  detachedFlush();
}

/** A beat. Creates state on the fly when SessionStart never fired. */
export function cmdBeat(argvAgent: string, payload: unknown, tag: string): void {
  const agent = detectAgent(argvAgent, payload);
  const { session } = normalizePayload(payload);
  if (!session) {
    noteOncePerMinute("no-session", `${agent}\tbeat payload names no session, nothing recorded; keys: ${payloadKeys(payload)}`);
    return;
  }
  const base = stateBase(agent, session);
  if (!existsSync(`${base}.meta.json`)) cmdStart(agent, payload);
  const k = tag === "tool" || tag === "stop" || tag === "prompt" ? tag : "tool";
  appendFileSync(`${base}.marks`, `${nowIso()} ${k}\n`, { mode: 0o600 });
}

/**
 * A session header as written by ANY version of this runtime. Two copies can
 * share ~/.shyre (the plugin's, and ~/.shyre/bin's written by `install`, which
 * is not auto-updated), so a header is read leniently: `agent` and `session`
 * must be there; anything else falls back. Refusing an unfamiliar shape would
 * drop a whole session's marks on the first field ever added.
 */
function coerceMeta(value: unknown, fallbackAgent: Agent, fallbackSession: string): Meta | null {
  if (!isRecord(value)) return null;
  const agent = typeof value.agent === "string" && value.agent ? value.agent : fallbackAgent;
  const session = typeof value.session === "string" && value.session ? value.session : fallbackSession;
  return {
    agent,
    label: typeof value.label === "string" && value.label ? value.label : labelFor(agent),
    session,
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    repoKey: typeof value.repoKey === "string" ? value.repoKey : null,
  };
}

/** SessionEnd. Spools one item per run; no network. A second source firing
 *  the same end (Cursor + the Claude plugin) finds no state and does nothing. */
/**
 * Read the third meter off the agent's own exporter.
 *
 * ⚠️ LOCALHOST, NO HEADERS, NOT THROUGH `http()`. That helper attaches the
 * bearer token to every request; this one must never carry it, because the
 * port is whatever is listening on the machine. Claude Code serves
 * `claude_code_token_usage_total` by `type` and `claude_code_cost_usage_total`
 * on `OTEL_EXPORTER_PROMETHEUS_PORT` (9464) when launched with
 * `CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=prometheus`.
 *
 * ⚠️ OWN SESSION ONLY. The exporter is first-come: a second concurrent
 * session runs normally and binds nothing, so a scrape can answer with
 * ANOTHER session's numbers. Every line is filtered on `session_id`, and a
 * scrape that names no line for this session is "absent" — the same answer
 * as no listener, a parse failure, or the port taken by something else.
 * Absent is absent; it is never reported as zero.
 *
 * The counters are cumulative for the process. A `--resume` reuses the
 * session id in a fresh process that starts at zero, which is fine: this
 * reads once, at the end, and attaches to that end.
 */
/** The exporter's port, or null when the variable is not a port number. */
export function prometheusPort(env: Record<string, string | undefined>): number | null {
  const raw = (env.OTEL_EXPORTER_PROMETHEUS_PORT ?? "").trim();
  if (raw === "") return 9464;
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

/** More than this from a localhost port is not a metrics page; stop reading. */
const SCRAPE_MAX_BYTES = 1_048_576;

export async function scrapeSessionTokens(session: string, fetchImpl: typeof fetch = fetch): Promise<AgentTokens | undefined> {
  const port = prometheusPort(process.env);
  if (port === null) return undefined;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 500);
  let text = "";
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/metrics`, { method: "GET", signal: ctl.signal, redirect: "manual" });
    if (res.status !== 200 || !res.body) return undefined;
    // Read with a ceiling: whatever holds the port decides how much it sends.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SCRAPE_MAX_BYTES) {
        ctl.abort();
        return undefined;
      }
      chunks.push(value);
    }
    text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
  return parseSessionTokens(text, session);
}

/** The index of the `}` that closes the label set — quote-aware, so a `}`
 *  inside a quoted label value, or an OpenMetrics exemplar after the value,
 *  cannot move it. -1 when the set never closes. */
export function labelSetClose(line: string, open: number): number {
  let quoted = false;
  for (let i = open + 1; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === "\\") i += 1;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "}") return i;
  }
  return -1;
}

/** Pure: the exporter's text → this session's counts, or nothing. */
export function parseSessionTokens(text: string, session: string): AgentTokens | undefined {
  const byModel = new Map<string, { input: number; output: number; cache_read: number; cache_creation: number }>();
  let cost = 0;
  let sawCost = false;
  const typeKey: Record<string, keyof AgentTokens> = { input: "input", output: "output", cacheRead: "cache_read", cacheCreation: "cache_creation" };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("claude_code_token_usage_total{") && !line.startsWith("claude_code_cost_usage_total{")) continue;
    const brace = line.indexOf("{");
    const close = labelSetClose(line, brace);
    if (brace < 0 || close < brace) continue;
    const labels: Record<string, string> = {};
    for (const m of line.slice(brace + 1, close).matchAll(/([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[m[1] ?? ""] = (m[2] ?? "").replace(/\\(["\\])/g, "$1");
    if (labels.session_id !== session) continue;
    const value = Number(line.slice(close + 1).trim().split(/\s+/)[0]);
    if (!Number.isFinite(value) || value < 0) continue;
    if (line.startsWith("claude_code_cost_usage_total{")) {
      cost += value;
      sawCost = true;
      continue;
    }
    const model = labels.model ?? "";
    const key = typeKey[labels.type ?? ""];
    if (!key || !model || key === "model" || key === "cost_usd_list") continue;
    // A counter that never incremented is not exported at all, so a type
    // with no line is a true zero for THIS session (a session with no cache
    // writes has no cacheCreation series). Different from the row, where a
    // NULL means "not reported": here presence of the metric at all is the
    // report, and the counts are whatever it says.
    const bucket = byModel.get(model) ?? { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
    bucket[key] += Math.round(value);
    byModel.set(model, bucket);
  }
  if (byModel.size === 0) return undefined;
  // The dominant model carries the counts. Tokens are per model; a sum across
  // models is a number with no unit.
  const [model, counts] = [...byModel.entries()].sort((a, b) => total(b[1]) - total(a[1]))[0] ?? [undefined, undefined];
  if (!model || !counts) return undefined;
  return { ...counts, model, cost_usd_list: sawCost ? Math.round(cost * 1e6) / 1e6 : 0 };
}

function total(c: { input: number; output: number; cache_read: number; cache_creation: number }): number {
  return c.input + c.output + c.cache_read + c.cache_creation;
}

export async function cmdEnd(argvAgent: string, payload: unknown, { idleCapSeconds }: Pick<Config, "idleCapSeconds">, scrape: (session: string) => Promise<AgentTokens | undefined> = scrapeSessionTokens): Promise<void> {
  const agent = detectAgent(argvAgent, payload);
  const { session } = normalizePayload(payload);
  if (!session) {
    noteOncePerMinute("no-session", `${agent}\tend payload names no session, nothing recorded; keys: ${payloadKeys(payload)}`);
    return;
  }
  const base = stateBase(agent, session);
  if (!existsSync(`${base}.meta.json`)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(`${base}.meta.json`, "utf8"));
  } catch (err) {
    logRefusal(`${basename(base)}\tunreadable session meta, marks left in place: ${errorMessage(err)}`);
    return;
  }
  const meta = coerceMeta(parsed, agent, session);
  if (!meta) {
    logRefusal(`${basename(base)}\tsession meta is not an object, marks left in place`);
    return;
  }
  // A header from another version may carry the repo in a shape this copy
  // does not read. "Unmapped" settles an item for good, so before the runs
  // are spooled under no repo, look at the working directory again.
  if (meta.repoKey === null && meta.cwd) meta.repoKey = repoKeyFromRemote(gitRemote(meta.cwd));
  let marksText = "";
  try {
    marksText = readFileSync(`${base}.marks`, "utf8");
  } catch {
    marksText = "";
  }
  const runs = segmentRuns(parseMarks(marksText), idleCapSeconds);
  // The third meter, read while the agent's process is still alive and its
  // exporter still bound. Attached to the last run only — see SpoolItem.
  let last: { path: string; item: SpoolItem } | undefined;
  for (const run of runs) {
    const item: SpoolItem = {
      agent: meta.agent,
      label: meta.label,
      session,
      cwd: meta.cwd,
      repo_key: meta.repoKey,
      start_time: run.start,
      end_time: run.end,
      agent_runtime_min: run.runtimeMin,
      agent_wait_min: run.waitMin,
      marks: run.marks,
      // Keyed on the run's START INSTANT, not its ordinal: a session id is
      // reused across /clear and --resume, so "run 1" would recur, and the
      // server would answer the second with the FIRST entry as a replay —
      // a 2xx that deleted the spool file and lost the hours silently.
      idempotency_key: `${session}:${run.start}`,
      session_ref: session,
      created: nowIso(),
    };
    const path = join(spoolDir(), `${agent}-${basename(base)}-${run.start.replace(/[^0-9TZ]/g, "")}.json`);
    writeAtomic(path, JSON.stringify(item), 0o600);
    last = { path, item };
  }
  // ⚠️ SPOOL FIRST, SCRAPE SECOND. The hours are on disk before anything
  // waits on a socket: a SessionEnd killed inside the half-second scrape
  // (terminal closed, hook timeout) loses the tokens, never the run. The
  // third meter rides the LAST run only — see SpoolItem.agent_tokens.
  if (last) {
    let tokens: AgentTokens | undefined;
    try {
      tokens = await scrape(session);
    } catch {
      tokens = undefined;
    }
    if (tokens) writeAtomic(last.path, JSON.stringify({ ...last.item, agent_tokens: tokens }), 0o600);
  }
  try {
    unlinkSync(`${base}.marks`);
  } catch {
    /* already gone */
  }
  try {
    unlinkSync(`${base}.meta.json`);
  } catch {
    /* already gone */
  }
  if (runs.length > 0) detachedFlush();
}

interface ProjectRow {
  id: string;
  github_repo: string | null;
}

/** Shared across one sweep: one projects lookup per flush, not per item. */
export interface ProjectsCache {
  list?: ProjectRow[];
  failed?: number;
}

type Resolved = { id: string } | { id: null; reason: "unmapped" } | { id: null; reason: "lookup-failed"; status: number };
/** `failed` codes that are not HTTP statuses: -1 no network, -2 an empty list. */

function toProjectRows(value: unknown): ProjectRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: ProjectRow[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    rows.push({ id: entry.id, github_repo: typeof entry.github_repo === "string" ? entry.github_repo : null });
  }
  return rows;
}

/**
 * Resolve the project for a spool item: the local map, then the server's
 * `github_repo` across EVERY lifecycle status (a completed fixed-bid project
 * still gets warranty sessions). Three answers, and they must stay distinct:
 * an id; `unmapped` (the server answered and nothing names this repo); and
 * `lookup-failed` (the server did not answer — revoked token, 429, outage).
 * The first version folded the third into the second and DELETED the entry
 * with "no project names this repo" as the reason; the codebase's own rule
 * is that an empty result is not a fact.
 */
async function resolveProject(item: SpoolItem, cfg: Config, projectsCache: ProjectsCache): Promise<Resolved> {
  const fromMap = resolveFromMap(readMapFile(), item.repo_key);
  if (fromMap) return { id: fromMap };
  if (!item.repo_key) return { id: null, reason: "unmapped" };
  if (!projectsCache.list && !projectsCache.failed) {
    const res = await http("GET", `${cfg.apiUrl}/api/v1/projects?status=all`, {
      apiKey: cfg.apiKey,
      agent: item.agent,
      session: item.session,
    });
    if (res.status > 0) item.contacted = true;
    const rows = res.status === 200 ? toProjectRows(res.json) : null;
    // `|| -1`: no network reports status 0, which is falsy and would re-dial
    // (and re-wait the full timeout) for every item in the sweep. An EMPTY
    // list (-2) is not the fact "nothing names this repo" either: a token on
    // the wrong team, or a filter the server added, reads as no projects, and
    // settling every run as unmapped on it would delete them all.
    if (rows && rows.length > 0) projectsCache.list = rows;
    else projectsCache.failed = rows ? -2 : res.status || -1;
  }
  const list = projectsCache.list;
  if (!list) {
    const failed = projectsCache.failed ?? 0;
    return { id: null, reason: "lookup-failed", status: failed === -2 ? -2 : failed > 0 ? failed : 0 };
  }
  const hit = list.find((p) => p.github_repo !== null && p.github_repo.toLowerCase() === item.repo_key);
  return hit ? { id: hit.id } : { id: null, reason: "unmapped" };
}

/** Statuses after which the same request would be refused again. */
function isFinalRefusal(status: number): boolean {
  // 401 (a rotated or expired token), 408 and 429 are conditions that pass;
  // 403 (period locked, scope), 400/404/409/422 and the rest are not.
  return status >= 400 && status < 500 && ![401, 408, 429].includes(status);
}

/** How the coverage check ended: with every relevant entry, or without. */
export type Coverage = { complete: true; entries: unknown[] } | { complete: false; reason: string };

/** Pages the list can take before the check gives up and says so. */
export const COVERAGE_MAX_PAGES = 10;
/** Rows per page — the server's cap, pinned to the migration by test. */
export const COVERAGE_PAGE_SIZE = 100;

/**
 * Every entry of yours that could cover any part of [start, end): the list
 * across ALL projects, paged newest-first with `until` until the page is
 * short or reaches `since`, plus the running timer, which the list would
 * not return once it is more than a day old. Anything short of that is
 * "coverage unknown", never "no coverage": a page the server did not
 * answer, a 200 whose body is not a list (a login page from something in
 * front of the API), or a list still full after COVERAGE_MAX_PAGES.
 */
export async function fetchCoverage(item: SpoolItem, cfg: Config, tag = ""): Promise<Coverage> {
  const since = new Date(Date.parse(item.start_time) - 86400 * 1000).toISOString();
  const entries: unknown[] = [];
  let until = item.end_time;
  let previousOldest = Number.POSITIVE_INFINITY;
  for (let page = 0; page < COVERAGE_MAX_PAGES; page += 1) {
    const url = `${cfg.apiUrl}/api/v1/entries?limit=${COVERAGE_PAGE_SIZE}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`;
    let res = await http("GET", url, { apiKey: cfg.apiKey, agent: item.agent, session: item.session });
    if (res.status === 429) {
      // The token's own minute budget, spent by this sweep. One pause, one
      // retry; a backlog of items must not rate-limit itself into the
      // double posts this check exists to prevent.
      await new Promise((r) => setTimeout(r, 1500));
      res = await http("GET", url, { apiKey: cfg.apiKey, agent: item.agent, session: item.session });
    }
    if (res.status > 0) item.contacted = true;
    if (res.status !== 200) return { complete: false, reason: `coverage check answered ${res.status || "no network"}` };
    if (!Array.isArray(res.json)) return { complete: false, reason: "coverage check answered 200 without an entries list" };
    entries.push(...(res.json as unknown[]));
    if (res.json.length < COVERAGE_PAGE_SIZE) break;
    // Full page: the next page starts one millisecond ABOVE the oldest row,
    // so rows tied at that instant are fetched again rather than skipped —
    // the server orders by start_time then id, but a page boundary inside a
    // run of identical start times would otherwise drop the ones that did
    // not fit. A page that makes no progress (a hundred rows at one
    // instant) is coverage unknown, never silently short.
    let oldest = Number.POSITIVE_INFINITY;
    for (const e of res.json as unknown[]) {
      if (isRecord(e) && typeof e.start_time === "string") oldest = Math.min(oldest, Date.parse(e.start_time));
    }
    if (!Number.isFinite(oldest) || oldest < Date.parse(since)) break;
    if (oldest >= previousOldest) return { complete: false, reason: "coverage check made no progress: a page of entries sharing one start instant" };
    previousOldest = oldest;
    if (page === COVERAGE_MAX_PAGES - 1) return { complete: false, reason: `coverage check still truncated after ${COVERAGE_MAX_PAGES} pages` };
    until = new Date(oldest + 1).toISOString();
  }
  let timer = await http("GET", `${cfg.apiUrl}/api/v1/timer`, { apiKey: cfg.apiKey, agent: item.agent, session: item.session });
  if (timer.status === 429) {
    // Same pause as the list: a complete list must not be thrown away over
    // the token's own minute budget.
    await new Promise((r) => setTimeout(r, 1500));
    timer = await http("GET", `${cfg.apiUrl}/api/v1/timer`, { apiKey: cfg.apiKey, agent: item.agent, session: item.session });
  }
  if (timer.status === 401 || timer.status === 403) {
    // A knowable, permanent answer (the token lacks timer:read): the list is
    // still a complete list. Said once, not treated as unknown coverage.
    logRefusal(`${tag}\ttimer check answered ${timer.status}; the running timer is not visible to this token`);
  } else if (timer.status !== 200) {
    return { complete: false, reason: `timer check answered ${timer.status || "no network"}` };
  } else if (isRecord(timer.json) && typeof timer.json.start_time === "string") {
    entries.push({ start_time: timer.json.start_time, end_time: null });
  }
  return { complete: true, entries };
}

/**
 * Deliver one spool item. Returns true when the file can be removed:
 * posted, already covered, or refused for good. False keeps it for the next
 * sweep: no credential, no network, a redirect, a 5xx, or a refusal that a
 * token or rate-limit fix would clear. Settled stretches are recorded on
 * `item.done`, which the caller persists when the item is kept.
 */
export async function deliver(item: SpoolItem, cfg: Config, projectsCache: ProjectsCache = {}): Promise<boolean> {
  if (!cfg.apiKey) return false;
  const tag = `${item.label}\t${(item.repo_key || item.cwd).replace(/[\r\n\t]+/g, " ")}\t${item.start_time}..${item.end_time}`;
  const ws = Date.parse(item.start_time);
  const we = Date.parse(item.end_time);
  if (!Number.isFinite(ws) || !Number.isFinite(we) || we <= ws) {
    // Not a window. Nothing the server could accept, and not "covered".
    logRefusal(`${tag}\tinvalid window (end not after start, or unparseable): discarded`);
    return true;
  }
  const resolved = await resolveProject(item, cfg, projectsCache);
  if (resolved.id === null) {
    if (resolved.reason === "lookup-failed") {
      const why = resolved.status === -2 ? "the server listed no projects at all" : `${resolved.status || "no network"}`;
      logRefusal(`${tag}\tprojects lookup failed (${why}), kept for retry`);
      return false;
    }
    logRefusal(`${tag}\tunmapped: no map line and no project names this repo`);
    return true;
  }
  const projectId = resolved.id;
  // ALL of your projects, not this one: the run that was written down twice
  // was a hook entry on the child project under the agent's own entries on
  // the parent, and a per-project check could not see them.
  const coverage = await fetchCoverage(item, cfg, tag);
  let segments: Segment[] = [[isoSeconds(ws), isoSeconds(we)]];
  if (coverage.complete) {
    segments = uncoveredSegments(coverage.entries, item.start_time, item.end_time);
    if (segments.length === 0) {
      const dropped = Math.round(uncoveredMillis(coverage.entries, item.start_time, item.end_time) / 1000);
      logRefusal(dropped > 0
        ? `${tag}\tcovered: stood down; ${dropped} s uncovered under the one-minute floor, dropped`
        : `${tag}\tcovered: stood down, this window was already logged`);
      return true;
    }
    if (!isWhole(segments, ws, we)) {
      const posted = segments.reduce((n, [a, b]) => n + (Date.parse(b) - Date.parse(a)), 0);
      logRefusal(`${tag}\tcovered in part: stood down ${Math.round((we - ws - posted) / 60000)} min already logged; posting ${segments.length} uncovered segment(s)`);
    }
  } else {
    if (item.backfilled) {
      // Reconstructed time is not urgent, and the coverage check is the
      // only thing between it and a double count on another project.
      logRefusal(`${tag}\t${coverage.reason}; a backfilled run is kept for retry, never posted blind`);
      return false;
    }
    logRefusal(`${tag}\t${coverage.reason}; posting without it`);
  }
  const done = new Set(item.done ?? []);
  if (!coverage.complete && done.size > 0) {
    // Part of this run already landed and this sweep cannot see what. The
    // whole window is not a stretch that can be posted: it would land over
    // the part that did, under a different key, and the server's refusal is
    // same-project only. Kept for a sweep that can ask.
    logRefusal(`${tag}\tpart of this run already landed and coverage is unknown; kept for a sweep that can ask`);
    return false;
  }
  let settled = true;
  for (const [segStart, segEnd] of segments) {
    if (done.has(`${segStart}|${segEnd}`)) {
      // Already posted or refused for good on an earlier sweep: that stretch
      // is not posted twice. Coverage is known here, so whatever landed is
      // already out of `segments`, and a stretch still here was a final
      // refusal — skipping it settles it.
      continue;
    }
    const outcome = await postSegment(item, cfg, projectId, tag, segStart, segEnd, ws, we);
    if (outcome === "kept") settled = false;
    else done.add(`${segStart}|${segEnd}`);
  }
  item.done = [...done].sort();
  return settled;
}

/** One segment spanning exactly the run's window. */
function isWhole(segments: readonly Segment[], ws: number, we: number): boolean {
  const only = segments.length === 1 ? segments[0] : undefined;
  return only !== undefined && Date.parse(only[0]) === ws && Date.parse(only[1]) === we;
}

type SegmentOutcome = "posted" | "final" | "kept";

/**
 * Post one window of a run. A partial window carries meters recomputed from
 * the run's own marks; an item an older runtime wrote has no marks, and a
 * partial window of it carries none rather than the whole run's, which would
 * break the "runtime + wait == active" identity the entry is documented to
 * satisfy. The whole run keeps the meters it was spooled with, so a runtime
 * that never re-meters still posts what segmentRuns computed.
 */
async function postSegment(item: SpoolItem, cfg: Config, projectId: string, tag: string, segStart: string, segEnd: string, ws: number, we: number): Promise<SegmentOutcome> {
  let start = segStart;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const whole = Date.parse(start) === ws && Date.parse(segEnd) === we;
    const meters = whole ? { runtimeMin: item.agent_runtime_min, waitMin: item.agent_wait_min } : item.marks ? metersFor(item.marks, start, segEnd) : undefined;
    const body = buildEntryBody({
      project_id: projectId,
      label: item.label,
      start_time: start,
      end_time: segEnd,
      session_ref: item.session_ref,
      // A segment is keyed on ITS start instant, like a run: two segments of
      // one run must not replay each other.
      idempotency_key: whole ? item.idempotency_key : `${item.session}:${start}`,
      agent_runtime_min: meters?.runtimeMin,
      agent_wait_min: meters?.waitMin,
      prompt_marks: item.marks ? promptMarksFor(item.marks, start, segEnd) : undefined,
      backfilled: item.backfilled === true,
      // A split run's tokens cannot be apportioned to one of its segments;
      // only the whole run carries them.
      agent_tokens: whole ? item.agent_tokens : undefined,
    });
    const res = await http("POST", `${cfg.apiUrl}/api/v1/entries`, {
      apiKey: cfg.apiKey,
      agent: item.agent,
      session: item.session,
      body,
    });
    if (res.status > 0) item.contacted = true;
    if (res.status >= 200 && res.status < 300) {
      // A 2xx whose body is not the entry (an HTML page from something in
      // front of the API) is not a success.
      if (!isRecord(res.json)) {
        logRefusal(`${tag}\t${res.status} without an entry body, kept for retry`);
        return "kept";
      }
      // A 2xx whose entry is a DIFFERENT window is the server replaying an
      // earlier post under the same key — this stretch did not land.
      const gotStart = typeof res.json.start_time === "string" ? Date.parse(res.json.start_time) : Number.NaN;
      const gotEnd = typeof res.json.end_time === "string" ? Date.parse(res.json.end_time) : Number.NaN;
      if (Number.isFinite(gotStart) && Number.isFinite(gotEnd) && (Math.abs(gotStart - Date.parse(start)) > 1000 || Math.abs(gotEnd - Date.parse(segEnd)) > 1000)) {
        logRefusal(`${tag}\t${res.status} replayed an existing entry with a different window (${res.json.start_time}..${res.json.end_time}); ${start}..${segEnd} kept for retry`);
        return "kept";
      }
      return "posted";
    }
    if (res.status === 409 && attempt === 0) {
      const free = earliestFreeStart(isRecord(res.json) ? res.json.message : undefined);
      if (free && Date.parse(free) > Date.parse(start) && Date.parse(segEnd) - Date.parse(free) >= 60000) {
        start = free;
        continue;
      }
    }
    if (isFinalRefusal(res.status)) {
      // A 400 on the FIRST attempt is kept once: "end_time is in the future"
      // is a clock a few minutes fast, and a field the server does not know
      // yet is a server behind the client — both clear on their own, and
      // deleting the run over them lost the hours for good.
      if (res.status === 400 && (item.tries ?? 0) < 1) {
        logRefusal(`${tag}\t400 on the first attempt, kept for one retry\t${res.text.replace(/\s+/g, " ").slice(0, 400)}`);
        return "kept";
      }
      logRefusal(`${tag}\t${res.status}\t${res.text.replace(/\s+/g, " ").slice(0, 400)}`);
      return "final";
    }
    // The reason rides along when there is no status to name one: a refused
    // TLS setup, an aborted request, a socket error.
    logRefusal(`${tag}\t${res.status || "no network"}\tkept for retry${res.status ? "" : `\t${res.text.replace(/\s+/g, " ").slice(0, 200)}`}`);
    return "kept";
  }
  return "kept";
}

/**
 * A spool item as written by ANY version of this runtime (see coerceMeta for
 * why). The five fields that name the entry — session, window, key — must be
 * strings; everything else falls back. A file that parsed but has no usable
 * window is not "unreadable": it is kept for the next sweep and for the
 * seven-day prune, never deleted on sight.
 */
function coerceSpoolItem(value: unknown): SpoolItem | null {
  if (!isRecord(value)) return null;
  const session = typeof value.session === "string" ? value.session : typeof value.session_ref === "string" ? value.session_ref : null;
  const start = typeof value.start_time === "string" ? value.start_time : null;
  const end = typeof value.end_time === "string" ? value.end_time : null;
  if (!session || !start || !end) return null;
  const agent = typeof value.agent === "string" && value.agent ? value.agent : "claude";
  // A meter that is not there is not zero: an item without meters posts none.
  const minutes = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  // Marks are optional and read leniently: a malformed element is dropped,
  // and an item with no usable marks is posted on its spooled meters.
  const marks: Mark[] | undefined = Array.isArray(value.marks)
    ? value.marks.flatMap((m: unknown) => (isRecord(m) && typeof m.t === "number" && Number.isFinite(m.t) ? [{ t: m.t, k: typeof m.k === "string" ? m.k : "tool" }] : []))
    : undefined;
  return {
    agent,
    label: typeof value.label === "string" && value.label ? value.label : labelFor(agent),
    session,
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    repo_key: typeof value.repo_key === "string" ? value.repo_key : null,
    start_time: start,
    end_time: end,
    agent_runtime_min: minutes(value.agent_runtime_min),
    agent_wait_min: minutes(value.agent_wait_min),
    idempotency_key: typeof value.idempotency_key === "string" && value.idempotency_key ? value.idempotency_key : `${session}:${start}`,
    session_ref: typeof value.session_ref === "string" ? value.session_ref : session,
    ...(marks ? { marks } : {}),
    ...(Array.isArray(value.done) ? { done: value.done.filter((d: unknown): d is string => typeof d === "string") } : {}),
    ...(typeof value.created === "string" ? { created: value.created } : {}),
    ...(typeof value.tries === "number" && Number.isFinite(value.tries) && value.tries >= 0 ? { tries: value.tries } : {}),
    ...(typeof value.drop_attempts === "number" && Number.isFinite(value.drop_attempts) && value.drop_attempts >= 0 ? { drop_attempts: value.drop_attempts } : {}),
    ...(value.backfilled === true ? { backfilled: true } : {}),
  };
}

/** Sweeps an item may be kept through before it is pruned regardless of age — an item without a `created` stamp is rewritten on every keep, so age alone would never prune it. */
export const MAX_TRIES = 20;
/** Days a tried-and-kept item waits in the spool before it is dropped. Seven
 *  lost a week of hours to an outage that outlasted it; a stale file costs
 *  nothing. The marketing copy and the guide name this number. */
export const PRUNE_AFTER_DAYS = 30;
/** Where the runtime tells the server it is giving up on a run, so the drop
 *  reaches the token owner's activity list and not only this machine's log. */
export const DROP_REPORT_PATH = "/api/v1/entries/dropped";

/** Days an undeliverable run may wait for the server to be TOLD of its drop
 *  before the file goes with only the local log to show for it. Bounds the
 *  keep: a kill switch left on, a server without the route, a token never
 *  re-minted. Three times the retry window. */
export const DROP_GIVE_UP_DAYS = 90;
/** Answered drop reports that did not record the drop, before the give-up
 *  may fire. Age alone deleted a run on the first sweep after four months
 *  away — before the network was even up — with "could not be told for 90
 *  days" as its epitaph, when it had never been asked once. */
export const DROP_GIVE_UP_ATTEMPTS = 3;
/** Only an owner/repo key travels. A remote that is a local path
 *  ("/Users/…/client-secret", "file:///…", a network share) is a working
 *  directory by another name, which the payload promise says never leaves. */
const REPO_KEY_SHAPE = /^(?!\.{1,2}\/)[a-z0-9._-]+\/[a-z0-9._-]+$/;
export type DropReason = "retry_window_elapsed" | "retry_cap_reached";

/**
 * Tell the server a run is about to be dropped. Sent BEFORE the delete:
 * a drop nobody but this laptop's log knew about was silent loss. Carries
 * the same fields the entry would have — window, label, session, key — plus
 * the counts and why; never the working directory or the marks.
 *
 * Only a verified record — a 2xx whose body is the route's `{recorded:
 * true}` — is a report. Everything else means the server has not heard it:
 * no answer, a 3xx (a proxy answered, not Shyre), a 401 (a rotated token,
 * or the team's integrations switched off — a security control that must
 * hold data, not erase it), a 404 from a server without the route, a 5xx,
 * a 200 that is a sign-in page. The caller keeps the file for all of them,
 * bounded by DROP_GIVE_UP_DAYS.
 */
async function reportDrop(item: SpoolItem, cfg: Config, reason: DropReason, keptDays: number): Promise<{ reported: boolean; contacted: boolean; why: string }> {
  if (!cfg.apiKey) return { reported: false, contacted: false, why: "no credential" };
  const res = await http("POST", `${cfg.apiUrl}${DROP_REPORT_PATH}`, {
    apiKey: cfg.apiKey,
    agent: item.agent,
    session: item.session,
    body: {
      agent_label: item.label.slice(0, 64),
      repo_key: item.repo_key && REPO_KEY_SHAPE.test(item.repo_key) ? item.repo_key : undefined,
      start_time: item.start_time,
      end_time: item.end_time,
      session_ref: item.session_ref.slice(0, 128),
      idempotency_key: item.idempotency_key.slice(0, 128),
      tries: item.tries ?? 0,
      kept_days: Math.max(0, keptDays),
      reason,
    },
  });
  if (res.status >= 200 && res.status < 300) {
    if (isRecord(res.json) && res.json.recorded === true) return { reported: true, contacted: true, why: "" };
    return { reported: false, contacted: true, why: `${res.status} without a record` };
  }
  return { reported: false, contacted: res.status > 0, why: res.status ? String(res.status) : `no network: ${res.text.replace(/\s+/g, " ").slice(0, 120)}` };
}

/** Sweep the spool, then the leftovers. Runs detached; never prints. */
export async function cmdFlush(cfg: Config): Promise<void> {
  const dir = spoolDir();
  const cache: ProjectsCache = {};
  const dayAgo = Date.now() - 86400 * 1000;
  const weekAgo = Date.now() - 7 * 86400 * 1000;
  const pruneBefore = Date.now() - PRUNE_AFTER_DAYS * 86400 * 1000;
  const giveUpBefore = Date.now() - DROP_GIVE_UP_DAYS * 86400 * 1000;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name.endsWith(".tmp")) {
      // A crash between write and rename leaves one of these; it is never
      // a deliverable item.
      try {
        if (statSync(path).mtimeMs < dayAgo) unlinkSync(path);
      } catch {
        /* gone */
      }
      continue;
    }
    if (!name.endsWith(".json")) continue;
    try {
      const stat = statSync(path);
      // Only files are items; a directory that happens to end in .json is
      // not ours to unlink, and would throw on every sweep if we tried.
      if (!stat.isFile()) continue;

      // Reading and parsing are separate failures. A read that fails
      // (permissions, a transient I/O error) says nothing about the item, so
      // it is KEPT for the next sweep; only text that is not JSON — which no
      // version of this runtime could ever deliver — is removed.
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (err) {
        logRefusal(`${name}\tcould not be read, kept for retry: ${errorMessage(err)}`);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        logRefusal(`${name}\tunreadable: ${errorMessage(err)}`);
        unlinkSync(path);
        continue;
      }
      const item = coerceSpoolItem(parsed);
      if (!item) {
        // Parsed, but without a window this runtime can post. Another copy of
        // the runtime may understand it; leave it to that copy or to the prune.
        if (stat.mtimeMs < pruneBefore) {
          logRefusal(`${name}\tpruned: shape not recognized by any sweep for ${PRUNE_AFTER_DAYS} days`);
          unlinkSync(path);
        } else {
          logRefusal(`${name}\tshape not recognized by runtime ${VERSION}, kept`);
        }
        continue;
      }
      // Pruned only after it was TRIED and kept for PRUNE_AFTER_DAYS — a
      // Friday session whose flush died with the lid, then a vacation, is
      // delivered on the first sweep back, not pruned unattempted. The age is
      // the item's own `created` (an older item without one uses the file's
      // time), because recording a delivered part rewrites the file.
      const createdMs = item.created ? Date.parse(item.created) : Number.NaN;
      const age = Number.isFinite(createdMs) ? createdMs : stat.mtimeMs;
      // MAX_TRIES is for items with no creation stamp — an older runtime's —
      // which a rewrite would otherwise keep young forever.
      const windowElapsed = age < pruneBefore && (item.tries ?? 0) >= 1;
      if (windowElapsed || (!item.created && (item.tries ?? 0) >= MAX_TRIES)) {
        const why = `kept for retry ${item.tries} time(s)${windowElapsed ? ` over ${PRUNE_AFTER_DAYS} days` : ""}`;
        // Told on an earlier sweep whose delete then failed: not said twice.
        if (isRecord(parsed) && parsed.drop_reported === true) {
          logRefusal(`${name}\tpruned: ${why}; reported to the server on an earlier sweep`);
          unlinkSync(path);
          continue;
        }
        // The server is told before the file goes, and only a verified
        // record deletes. If it cannot be told, the file stays: a drop during
        // the outage that caused it would be the one nobody ever hears about.
        const report = await reportDrop(item, cfg, windowElapsed ? "retry_window_elapsed" : "retry_cap_reached", Math.round((Date.now() - age) / (86400 * 1000)));
        if (report.reported) {
          logRefusal(`${name}\tpruned: ${why}; reported to the server`);
          try {
            unlinkSync(path);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
              // Remember that the server knows, so the next sweep deletes
              // without reporting the same drop again. Covers a file the OS
              // holds locked (Windows), not an unwritable directory — there
              // the mark cannot be written either, and the next sweep says
              // the drop again, bounded by the server's ceiling.
              try {
                writeAtomic(path, JSON.stringify({ ...(isRecord(parsed) ? parsed : {}), drop_reported: true }), 0o600);
              } catch (err2) {
                logRefusal(`${name}\tcould not delete or mark the reported item: ${errorMessage(err2)}`);
              }
            }
          }
          continue;
        }
        // Kept until the server can be told — but not forever. Past the
        // give-up bound the file goes with this line as its only record.
        // An answered report that did not record is an attempt; no answer
        // is not — a closed laptop, a VPN not yet up, a key not yet exported
        // must not run this down. Remembered on the file.
        if (report.contacted) {
          item.drop_attempts = (item.drop_attempts ?? 0) + 1;
          try {
            writeAtomic(path, JSON.stringify({ ...(isRecord(parsed) ? parsed : {}), drop_attempts: item.drop_attempts }), 0o600);
          } catch (err) {
            logRefusal(`${name}\tcould not record the drop attempt: ${errorMessage(err)}`);
          }
        }
        const attempts = item.drop_attempts ?? 0;
        if (attempts >= DROP_GIVE_UP_ATTEMPTS && (age < giveUpBefore || !item.created)) {
          logRefusal(`${name}\tpruned: ${why}; the server could not be told in ${attempts} answered attempt(s) over ${DROP_GIVE_UP_DAYS} days (last answer: ${report.why})`);
          unlinkSync(path);
          continue;
        }
        logRefusal(`${name}\tto be dropped (${why}); the server could not be told (${report.why}), kept until it can`);
        continue;
      }
      const before = JSON.stringify({ done: item.done ?? [], tries: item.tries ?? 0 });
      if (await deliver(item, cfg, cache)) {
        try {
          unlinkSync(path);
        } catch (err) {
          // A concurrent sweep — every SessionStart and every end spawns
          // one — delivered and removed it first. The idempotency key kept
          // the data right; only the log needs to tell the truth.
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          logRefusal(`${name}\tremoved by a concurrent sweep`);
        }
      } else {
        // A sweep that never reached the server — no credential, no network,
        // certificate checks off — learned nothing about the item and is not
        // a try; twenty of those in a morning would otherwise prune a run.
        if (item.contacted) item.tries = (item.tries ?? 0) + 1;
        if (JSON.stringify({ done: item.done ?? [], tries: item.tries ?? 0 }) !== before) {
          // Part of the run landed, or a try is being counted. Remembered in
          // place; a failure to rewrite just means the next sweep asks again.
          try {
            if (existsSync(path)) writeAtomic(path, JSON.stringify({ ...JSON.parse(text), done: item.done, tries: item.tries }), 0o600);
          } catch (err) {
            logRefusal(`${name}\tcould not record the sweep's result: ${errorMessage(err)}`);
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        logRefusal(`${name}\tremoved by a concurrent sweep`);
        continue;
      }
      // A failure INSIDE delivery (not a parse failure, handled above): keep
      // the file, say why, and let the next sweep try again.
      logRefusal(`${name}\tdelivery threw, kept for retry: ${errorMessage(err)}`);
    }
  }
  // Sessions nobody ended — a hard kill, a beat that arrived after the end
  // and recreated state — would otherwise sit forever. A week is long past
  // any live session.
  const sessions = sessionsDir();
  for (const name of readdirSync(sessions)) {
    const path = join(sessions, name);
    try {
      if (statSync(path).mtimeMs < weekAgo) {
        if (name.endsWith(".meta.json")) logRefusal(`${name}\tpruned: session never ended, marks discarded`);
        unlinkSync(path);
      }
    } catch {
      /* gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Installers
// ---------------------------------------------------------------------------

/**
 * The shell-form command Codex and Cursor run. The path is written into the
 * user's GLOBAL hook config and executed on every tool call, and it derives
 * from `SHYRE_HOME`, which a repo's direnv or devcontainer can set — so it
 * is validated, not quoted around. Letters, digits, `_ . / \ : -` and
 * spaces only; double quotes are safe for that set in sh, cmd and PowerShell
 * alike. Anything else is refused — including `~`, which no shell expands
 * inside quotes, so an unexpanded `SHYRE_HOME=~/.shyre` would be a silent
 * no-op forever.
 */
export function nodeCommand(scriptPath: string, agent: string, args: string): string {
  if (!/^[A-Za-z0-9_./\\: -]+$/.test(scriptPath)) {
    throw new Error(`refusing to write a hook command for a path with shell-significant characters: ${scriptPath}`);
  }
  return `node "${scriptPath}" ${agent} ${args}`;
}

/** Where this file really is — through any symlink. */
function selfPath(): string {
  return fileURLToPath(import.meta.url);
}

/** Copy this file to ~/.shyre/bin so agent configs point at a stable path. */
function installRuntimeCopy(): string {
  const bin = ensurePrivateDir(join(shyreHome(), "bin"));
  const target = join(bin, "shyre-hook.mjs");
  const self = selfPath();
  if (self !== target) writeAtomic(target, readFileSync(self, "utf8"));
  return target;
}

/**
 * Read a JSON file the user owns. A file that exists but does not parse is
 * NOT treated as empty: the first version did, and `install` then replaced a
 * user's whole hooks file — their own shell-audit hook included — with only
 * ours, exit 0, no backup, no warning.
 */
function readUserJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} exists but is not valid JSON (${errorMessage(err)}); fix or move it, then run install again — nothing was changed`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${path} exists but is not a JSON object; fix or move it, then run install again — nothing was changed`);
  }
  return parsed;
}

interface CommandHook {
  type: "command";
  command: string;
  timeout?: number;
}

interface ClaudeShapedEntry {
  matcher?: string;
  hooks: CommandHook[];
}

export interface ClaudeShapedHooks {
  hooks: Record<string, ClaudeShapedEntry[]>;
}

export interface CursorHooksFile {
  version: 1;
  hooks: Record<string, { command: string }[]>;
}

/** Claude-shaped hooks.json (Claude Code and Codex share the schema). */
export function claudeShapedHooks(agent: "claude" | "codex", scriptPath: string, timeouts: Record<string, number> = {}): ClaudeShapedHooks {
  const hooks: Record<string, ClaudeShapedEntry[]> = {};
  for (const [event, args] of HOOK_WIRING[agent]) {
    const hook: CommandHook = { type: "command", command: nodeCommand(scriptPath, agent, args) };
    const timeout = timeouts[event];
    if (timeout !== undefined && timeout > 0) hook.timeout = timeout;
    hooks[event] = [event === "PostToolUse" ? { matcher: ".*", hooks: [hook] } : { hooks: [hook] }];
  }
  return { hooks };
}

/** Cursor's hooks.json: `version: 1`, flat per-event arrays of `{ command }`. */
export function cursorHooks(scriptPath: string): CursorHooksFile {
  const hooks: Record<string, { command: string }[]> = {};
  for (const [event, args] of HOOK_WIRING.cursor) {
    hooks[event] = [{ command: nodeCommand(scriptPath, "cursor", args) }];
  }
  return { version: 1, hooks };
}

/** Is this hook entry one of ours — a `node … shyre-hook.mjs <agent> <verb>` command?
 *  The quoted branch may contain spaces (`"C:\Users\John Smith\…"`); the
 *  first version could not match its own command on such a path and so
 *  duplicated every hook on each re-install. */
const OURS = /\bnode\s+(?:"[^"]*shyre-hook\.mjs"|\S*shyre-hook\.mjs)\s+(?:claude|codex|cursor|gemini|copilot|opencode)\s+(?:start|beat|end)\b/;

function isOurEntry(entry: unknown): boolean {
  const commands: string[] = [];
  if (isRecord(entry)) {
    if (typeof entry.command === "string") commands.push(entry.command);
    if (Array.isArray(entry.hooks)) {
      for (const h of entry.hooks) if (isRecord(h) && typeof h.command === "string") commands.push(h.command);
    }
  }
  return commands.some((c) => OURS.test(c));
}

/** Merge our events into an existing hooks object; only entries that ARE
 *  ours are replaced. A user's wrapper that merely mentions our filename
 *  stays. */
function mergeHooks(existing: Record<string, unknown>, ours: { hooks: Record<string, unknown[]>; version?: number }): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  const prevHooks = isRecord(out.hooks) ? { ...out.hooks } : {};
  const hooks: Record<string, unknown> = prevHooks;
  for (const [event, entries] of Object.entries(ours.hooks)) {
    const prev = hooks[event];
    const kept = Array.isArray(prev) ? prev.filter((e: unknown) => !isOurEntry(e)) : [];
    hooks[event] = [...kept, ...entries];
  }
  out.hooks = hooks;
  if (ours.version !== undefined) out.version = ours.version;
  return out;
}

const CONVENTION = `## Shyre — log your own time

When you finish a substantial unit of work in a repo that is tracked in Shyre,
log the time yourself: \`GET /api/v1/projects\` (bearer \`$SHYRE_API_KEY\`)
to find the project by its \`github_repo\` and pick a category, then
\`POST /api/v1/entries\` with ISO-8601 start/end WITH offset, a one-line
outcome description, \`agent_label\` naming this agent, \`session_ref\`, and an
\`idempotency_key\` unique per unit. Log ACTIVE time, never elapsed span;
\`end_time\` may never be past the clock; never round \`start_time\` down
(copy the previous entry's \`end_time\`); on a 409, retry once with the
earliest free start it names. The hooks record the session as a backstop
and stand down for the minutes your entries already cover. Parallel sessions
APPORTION a person's time; they do not each claim it: if two sessions ran
side by side, log the person's time once, to one project, or split it.
`;

function upsertBlock(path: string, block: string, marker: string): boolean {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.includes(marker)) return false;
  writeUserFile(path, `${existing.trimEnd()}${existing ? "\n\n" : ""}${block}`);
  return true;
}

/**
 * The origin `install` writes into a user's global agent config. Never the
 * environment's: a `SHYRE_API_URL` set for one shell — a devcontainer, a
 * direnv block trusted once, a colleague's terminal — would otherwise become
 * a permanent redirect of the bearer token for every future session, with
 * nothing printed. A non-default origin is written only when asked for on
 * the command line, and every install prints the origin it wrote.
 */
export function installOrigin(argv: readonly string[]): string {
  const flag = argv.find((a) => a.startsWith("--api-url="));
  if (!flag) return DEFAULT_API_URL;
  const url = validApiUrl(flag.slice("--api-url=".length));
  if (!url) throw new Error(`--api-url must be an https origin with no path (got ${JSON.stringify(flag.slice("--api-url=".length))})`);
  return url;
}

export function installCodex(home: string = homedir(), scriptPath: string, apiUrl: string = DEFAULT_API_URL): string[] {
  const dir = ensureDir(join(home, ".codex"));
  const hooksPath = join(dir, "hooks.json");
  const merged = mergeHooks(readUserJson(hooksPath), claudeShapedHooks("codex", scriptPath, { SessionEnd: 3 }));
  writeUserFile(hooksPath, `${JSON.stringify(merged, null, 2)}\n`);
  const tomlPath = join(dir, "config.toml");
  const toml = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
  const changed = [hooksPath];
  if (!/^\[mcp_servers\.shyre\]/m.test(toml)) {
    // `apiUrl` is validated to the URL character set, so it is safe inside a
    // TOML basic string.
    const block = `\n[mcp_servers.shyre]\nurl = "${apiUrl}/api/mcp"\nbearer_token_env_var = "SHYRE_API_KEY"\n`;
    writeUserFile(tomlPath, `${toml.trimEnd()}\n${block}`);
    changed.push(tomlPath);
  }
  if (upsertBlock(join(dir, "AGENTS.md"), CONVENTION, "## Shyre — log your own time")) changed.push(join(dir, "AGENTS.md"));
  return changed;
}

/**
 * What the user still has to do after `install <agent>`. Codex refuses to
 * run a hook until its exact definition has been trusted (keyed on a hash of
 * the command), so a file we wrote does nothing until they open Codex and
 * accept it — and again after any future change to the command string.
 */
export const POST_INSTALL_NOTES: Readonly<Record<"codex" | "cursor", readonly string[]>> = Object.freeze({
  codex: [
    "Open Codex and run /hooks to review and TRUST the shyre hooks — Codex skips untrusted hooks silently, and re-trusting is needed after any change to them.",
    "Codex hooks inherit your shell environment, so SHYRE_API_KEY exported there is enough; ~/.shyre/config.json is the fallback for shells that do not export it.",
  ],
  cursor: [
    "If the Claude Code plugin is installed too, Cursor loads it as well; the runtime detects the Cursor session from its payload and records it once, as Cursor.",
    "On Windows, Cursor delivers the hook payload through a POSIX heredoc, which cmd and PowerShell cannot parse; use WSL or Git Bash for cursor-agent there.",
  ],
});

function postInstallNotes(agent: string | undefined): readonly string[] {
  if (agent === "codex" || agent === "cursor") return POST_INSTALL_NOTES[agent];
  return [];
}

export function installCursor(home: string = homedir(), scriptPath: string, apiUrl: string = DEFAULT_API_URL): string[] {
  const dir = ensureDir(join(home, ".cursor"));
  const hooksPath = join(dir, "hooks.json");
  const mcpPath = join(dir, "mcp.json");
  // Read every file first, then write: "nothing was changed" must be true
  // when the second read is the one that refuses.
  const existingHooks = readUserJson(hooksPath);
  const mcp = readUserJson(mcpPath);
  const merged = mergeHooks(existingHooks, cursorHooks(scriptPath));
  writeUserFile(hooksPath, `${JSON.stringify(merged, null, 2)}\n`);
  const servers: Record<string, unknown> = isRecord(mcp.mcpServers) ? mcp.mcpServers : {};
  mcp.mcpServers = servers;
  const changed = [hooksPath];
  if (!servers.shyre) {
    servers.shyre = {
      url: `${apiUrl}/api/mcp`,
      headers: { Authorization: "Bearer ${SHYRE_API_KEY}" },
    };
    writeUserFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
    changed.push(mcpPath);
  }
  const rules = ensureDir(join(dir, "rules"));
  const rulePath = join(rules, "shyre.mdc");
  if (!existsSync(rulePath)) {
    writeAtomic(rulePath, `---\ndescription: Log your own time to Shyre\nalwaysApply: true\n---\n\n${CONVENTION}`, 0o644);
    changed.push(rulePath);
  }
  return changed;
}

/** Our hook entries removed from a hooks file; the user's own kept. */
function withoutOurHooks(existing: Record<string, unknown>): { file: Record<string, unknown>; changed: boolean } {
  const out: Record<string, unknown> = { ...existing };
  const prevHooks = isRecord(out.hooks) ? { ...out.hooks } : {};
  let changed = false;
  for (const [event, entries] of Object.entries(prevHooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((e: unknown) => !isOurEntry(e));
    if (kept.length !== entries.length) changed = true;
    if (kept.length === 0) delete prevHooks[event];
    else prevHooks[event] = kept;
  }
  out.hooks = prevHooks;
  return { file: out, changed };
}

/** The convention block removed from a Markdown file, from its marker to the next heading of the same level or the end. */
function withoutBlock(text: string, marker: string): string | null {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const rest = text.slice(at + marker.length);
  const next = rest.search(/\n## /);
  const after = next < 0 ? "" : rest.slice(next + 1);
  return `${text.slice(0, at).trimEnd()}${after ? `\n\n${after}` : "\n"}`;
}

export function uninstallCodex(home: string = homedir()): string[] {
  const dir = join(home, ".codex");
  const changed: string[] = [];
  const hooksPath = join(dir, "hooks.json");
  if (existsSync(hooksPath)) {
    const { file, changed: did } = withoutOurHooks(readUserJson(hooksPath));
    if (did) {
      writeUserFile(hooksPath, `${JSON.stringify(file, null, 2)}\n`);
      changed.push(hooksPath);
    }
  }
  const tomlPath = join(dir, "config.toml");
  if (existsSync(tomlPath)) {
    const toml = readFileSync(tomlPath, "utf8");
    // Our block: from its header to the next table header or the end.
    const stripped = toml.replace(/\n?\[mcp_servers\.shyre\][^[]*/m, "\n");
    if (stripped !== toml) {
      writeUserFile(tomlPath, `${stripped.trimEnd()}\n`);
      changed.push(tomlPath);
    }
  }
  const agentsPath = join(dir, "AGENTS.md");
  if (existsSync(agentsPath)) {
    const without = withoutBlock(readFileSync(agentsPath, "utf8"), "## Shyre — log your own time");
    if (without !== null) {
      writeUserFile(agentsPath, without, 0o644);
      changed.push(agentsPath);
    }
  }
  return changed;
}

export function uninstallCursor(home: string = homedir()): string[] {
  const dir = join(home, ".cursor");
  const changed: string[] = [];
  const hooksPath = join(dir, "hooks.json");
  if (existsSync(hooksPath)) {
    const { file, changed: did } = withoutOurHooks(readUserJson(hooksPath));
    if (did) {
      writeUserFile(hooksPath, `${JSON.stringify(file, null, 2)}\n`);
      changed.push(hooksPath);
    }
  }
  const mcpPath = join(dir, "mcp.json");
  if (existsSync(mcpPath)) {
    const mcp = readUserJson(mcpPath);
    const servers = isRecord(mcp.mcpServers) ? { ...mcp.mcpServers } : null;
    if (servers && servers.shyre !== undefined) {
      delete servers.shyre;
      mcp.mcpServers = servers;
      writeUserFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
      changed.push(mcpPath);
    }
  }
  const rulePath = join(dir, "rules", "shyre.mdc");
  if (existsSync(rulePath)) {
    unlinkSync(rulePath);
    changed.push(rulePath);
  }
  return changed;
}

export interface InstallOptions {
  apiUrl: string;
  uninstall: boolean;
}

export function cmdInstall(agent: string | undefined, opts: InstallOptions = { apiUrl: DEFAULT_API_URL, uninstall: false }): string[] {
  if (opts.uninstall) {
    if (agent === "codex") return uninstallCodex(homedir());
    if (agent === "cursor") return uninstallCursor(homedir());
    if (agent === "claude") throw new Error("Claude Code uninstalls through the plugin: claude plugin uninstall shyre");
    throw new Error(`no uninstaller for "${agent ?? ""}" (supported: codex, cursor)`);
  }
  const scriptPath = installRuntimeCopy();
  if (agent === "codex") return installCodex(homedir(), scriptPath, opts.apiUrl);
  if (agent === "cursor") return installCursor(homedir(), scriptPath, opts.apiUrl);
  if (agent === "claude") {
    throw new Error("Claude Code installs through the plugin: claude plugin install shyre@theshyre");
  }
  throw new Error(`no installer for "${agent ?? ""}" yet (supported: codex, cursor; Claude Code uses the plugin)`);
}

/** The doctor's lines; each computed on its own, so one failure does not hide the rest. */
/**
 * The third meter's one line of advice. It never proposes overriding an
 * exporter someone else configured: `OTEL_METRICS_EXPORTER` set to anything
 * without `prometheus` in it is that person's choice, and the line says the
 * meter is not read, not "change this".
 */
export function tokensDoctorLine(env: Record<string, string | undefined>): string {
  const exporter = (env.OTEL_METRICS_EXPORTER ?? "").trim();
  const prometheus = exporter.split(",").map((e) => e.trim().toLowerCase()).includes("prometheus");
  const telemetry = (env.CLAUDE_CODE_ENABLE_TELEMETRY ?? "").trim() === "1";
  const port = prometheusPort(env);
  if (telemetry && prometheus && port === null) {
    return `tokens: OTEL_EXPORTER_PROMETHEUS_PORT=${env.OTEL_EXPORTER_PROMETHEUS_PORT ?? ""} is not a port — the third meter is not read until it is one (1–65535)`;
  }
  if (telemetry && prometheus) {
    return `tokens: exporter on (127.0.0.1:${port}) — the third meter is read once, at session end, for this session's id only; one session per machine binds the port, the rest report nothing`;
  }
  if (exporter && !prometheus) {
    return `tokens: OTEL_METRICS_EXPORTER=${exporter} is another exporter — left alone; the third meter is not read`;
  }
  return "tokens: off — to record the third meter, export CLAUDE_CODE_ENABLE_TELEMETRY=1 and OTEL_METRICS_EXPORTER=prometheus before starting the agent (nothing leaves the machine but four counts, a model name and one list-price figure)";
}

export async function doctorLines(cfg: Config, cwd: string = process.cwd(), probe: boolean = cfg.apiUrl === DEFAULT_API_URL): Promise<string[]> {
  const lines: string[] = [`shyre-hook ${VERSION}`, `home: ${shyreHome()}`];
  const attempt = (label: string, fn: () => string): void => {
    try {
      lines.push(fn());
    } catch (err) {
      lines.push(`${label}: could not be read (${errorMessage(err)})`);
    }
  };
  attempt("api", () => `api: ${cfg.apiUrl}${cfg.apiUrl === DEFAULT_API_URL ? "" : `   WARNING: not the default ${DEFAULT_API_URL} — set by SHYRE_API_URL or ~/.shyre/config.json; the token is sent here`}`);
  // Only the prefix and four characters: doctor output ends up in issues.
  attempt("token", () => `token: ${cfg.apiKey ? `present (${cfg.apiKey.slice(0, 14)}…)` : "MISSING — export SHYRE_API_KEY or write ~/.shyre/config.json"}`);
  attempt("config file", () => {
    const configPath = join(shyreHome(), "config.json");
    const mode = modeOf(configPath);
    if (mode === undefined) return "config file: none";
    return `config file: ${mode & 0o077 ? `present — WARNING: mode ${mode.toString(8)} is readable by others; chmod 600 it` : "present, mode 600"}`;
  });
  attempt("idle cap", () => `idle cap: ${cfg.idleCapSeconds}s`);
  attempt("tls", () => (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ? "tls: WARNING: NODE_TLS_REJECT_UNAUTHORIZED=0 — the hook refuses to send the token while certificate checks are off" : "tls: certificate checks on"));
  attempt("tokens", () => tokensDoctorLine(process.env));
  // The repository the current directory is in, and whether anything names it.
  const remote = gitRemote(cwd);
  const repoKey = repoKeyFromRemote(remote);
  const mapFile = readMapFileFrom();
  attempt("repo", () => `repo: ${cwd} → ${remote ?? "no git remote"} → ${repoKey ?? "no repo key"}`);
  attempt("map", () => {
    if (!mapFile) return "map: none (server github_repo fallback only)";
    const hit = repoKey ? resolveFromMap(mapFile.map, repoKey) : null;
    const dflt = isRecord(mapFile.map) && typeof mapFile.map._default === "string" ? ` (a _default routes unmapped repos to ${mapFile.map._default})` : "";
    return `map: ${mapFile.path}${dflt} → ${hit ? `this repo → ${hit}` : "this repo is not in it"}`;
  });
  // One request: the token's validity and whether a project names this repo.
  // Not to a non-default origin unless asked — doctor is what a person runs
  // when the origin is wrong, and it must not hand the token to it.
  if (cfg.apiKey && !probe) {
    lines.push(`server: not asked — the origin is not the default; run doctor --probe to send the token to ${cfg.apiUrl}`);
  } else if (cfg.apiKey) {
    try {
      const res = await http("GET", `${cfg.apiUrl}/api/v1/projects?status=all`, { apiKey: cfg.apiKey, agent: "claude", session: "doctor" });
      const rows = res.status === 200 ? toProjectRows(res.json) : null;
      if (rows) {
        const hit = repoKey ? rows.find((p) => p.github_repo !== null && p.github_repo.toLowerCase() === repoKey) : undefined;
        lines.push(`server: ${res.status}, ${rows.length} project(s)${repoKey ? `; ${hit ? `github_repo names this repo → ${hit.id}` : "NO project's github_repo names this repo — sessions here will be kept, then pruned"}` : ""}`);
      } else {
        lines.push(`server: ${res.status === 401 ? "401 — the token is refused (revoked, expired, offboarded, or the team's integrations are off); re-mint it" : `${res.status || "no network"} — ${res.text.replace(/\s+/g, " ").slice(0, 120)}`}`);
      }
    } catch (err) {
      lines.push(`server: could not be asked (${errorMessage(err)})`);
    }
  } else {
    lines.push("server: not asked (no token)");
  }
  attempt("spool", () => {
    const dir = spoolDir();
    const spoolItems = readdirSync(dir).filter((n) => n.endsWith(".json"));
    const oldest = spoolItems.reduce((acc, n) => Math.min(acc, statSync(join(dir, n)).mtimeMs), Date.now());
    return `spool: ${spoolItems.length} pending${spoolItems.length ? ` (oldest ${Math.round((Date.now() - oldest) / 3600000)} h; pruned after 7 days once tried)` : ""}`;
  });
  attempt("sessions", () => {
    const dir = sessionsDir();
    const names = readdirSync(dir);
    const open = names.filter((n) => n.endsWith(".meta.json")).length;
    const newest = names.filter((n) => n.endsWith(".marks")).reduce((acc, n) => Math.max(acc, statSync(join(dir, n)).mtimeMs), 0);
    return `sessions: ${open} open; last mark recorded: ${newest ? new Date(newest).toISOString() : "never (no session has written a mark; if an agent is running, its hook is not firing or its payload is not read — see refusals)"}`;
  });
  attempt("refusals", () => {
    const path = refusalLogPath();
    if (!existsSync(path)) return `refusals: none logged (${path})`;
    const all = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
    const last = (all[all.length - 1] ?? "").replace(/shyre_pat_[A-Za-z0-9_-]+/g, "shyre_pat_[REDACTED]");
    return `refusals: ${all.length} line(s) in ${path}; last: ${last.slice(0, 200)}`;
  });
  return lines;
}

async function cmdDoctor(argv: readonly string[] = []): Promise<void> {
  const cfg = readConfig();
  const lines = await doctorLines(cfg, process.cwd(), cfg.apiUrl === DEFAULT_API_URL || argv.includes("--probe"));
  process.stdout.write(`${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// ── backfill: sessions from before the plugin was installed ──────────────
//
// The hooks record a session while it runs. Nothing reads a transcript
// afterward — EXCEPT this command, which the person runs by hand, on one
// machine, and which reads only what the hooks would have recorded live:
// the timestamp of each prompt and each agent turn, the working directory
// (to name the project) and the session id. It never keeps or sends what
// was said, what was written, or which files were touched; the line is
// parsed, five fields are taken, the rest is dropped on the spot.
//
// The runs it finds go through the same spool and the same coverage check
// as live runs, so a week already logged by hand is not double-counted,
// and every entry carries `backfilled: true`, which the server badges.

/** The only transcript fields the backfill takes. Named, so a test can
 *  hold the parser to this list. `toolUseResult` is read for its PRESENCE
 *  only: a tool's result comes back as a `type: "user"` line, and counting
 *  those as prompts turned a tool-call timeline into "the instants you sent
 *  a prompt" and charged the machine's own gaps to the person (SAL-194). */
const TRANSCRIPT_FIELDS = ["type", "timestamp", "cwd", "sessionId", "isMeta", "toolUseResult"] as const;

interface TranscriptEvent {
  type: string;
  t: number;
  cwd: string | null;
  sessionId: string | null;
  /** A `user` line that is a tool result, not a person typing. */
  toolResult: boolean;
}

/** Take the five fields off one transcript line; everything else is dropped here. */
export function pickTranscriptEvent(line: string): TranscriptEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const type = typeof parsed[TRANSCRIPT_FIELDS[0]] === "string" ? (parsed[TRANSCRIPT_FIELDS[0]] as string) : "";
  if (type !== "user" && type !== "assistant") return null;
  if (parsed[TRANSCRIPT_FIELDS[4]] === true) return null;
  const ts = typeof parsed[TRANSCRIPT_FIELDS[1]] === "string" ? Date.parse(parsed[TRANSCRIPT_FIELDS[1]] as string) : Number.NaN;
  if (!Number.isFinite(ts)) return null;
  const cwd = typeof parsed[TRANSCRIPT_FIELDS[2]] === "string" ? (parsed[TRANSCRIPT_FIELDS[2]] as string) : null;
  const sid = typeof parsed[TRANSCRIPT_FIELDS[3]] === "string" ? (parsed[TRANSCRIPT_FIELDS[3]] as string) : null;
  const toolResult = parsed[TRANSCRIPT_FIELDS[5]] !== undefined;
  return { type, t: ts, cwd, sessionId: sid, toolResult };
}

/** Marks as the hooks would have written them: a prompt per user line that is not a tool result, a
 *  tool beat per agent line, and the agent line right before a prompt is
 *  its stop — the gap that follows was the person's, not the machine's. */
export function marksFromTranscriptEvents(events: readonly TranscriptEvent[]): Mark[] {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const marks: Mark[] = sorted.map((e) => ({ t: e.t, k: e.type === "user" && !e.toolResult ? "prompt" : "tool" }));
  for (let i = 1; i < marks.length; i++) {
    const cur = marks[i];
    const prev = marks[i - 1];
    if (cur && prev && cur.k === "prompt" && prev.k === "tool") prev.k = "stop";
  }
  return marks;
}

export interface BackfillOptions {
  sinceMs: number;
  untilMs: number;
  dryRun: boolean;
  transcriptsDir: string;
}

function optionValue(argv: readonly string[], name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

export function backfillOptions(argv: readonly string[], env: Record<string, string | undefined> = process.env, now = Date.now()): BackfillOptions {
  const since = optionValue(argv, "since");
  const until = optionValue(argv, "until");
  const sinceMs = since ? Date.parse(since) : now - 30 * 86400 * 1000;
  const untilMs = until ? Date.parse(until) : now;
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs >= untilMs) {
    throw new Error("backfill: --since and --until must be dates (YYYY-MM-DD), since before until");
  }
  const explicit = optionValue(argv, "transcripts");
  const configDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR : join(homedir(), ".claude");
  return { sinceMs, untilMs, dryRun: argv.includes("--dry-run"), transcriptsDir: explicit ?? join(configDir, "projects") };
}

interface BackfillSession {
  sessionId: string;
  cwd: string | null;
  events: TranscriptEvent[];
}

/** Read every transcript under the directory into sessions, timestamps only. */
export function readTranscriptSessions(dir: string, sinceMs: number, untilMs: number): BackfillSession[] {
  const sessions = new Map<string, BackfillSession>();
  let projects: string[] = [];
  try {
    projects = readdirSync(dir).sort();
  } catch {
    return [];
  }
  for (const project of projects) {
    const projectDir = join(dir, project);
    let files: string[] = [];
    try {
      files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl")).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const path = join(projectDir, file);
      try {
        // A transcript last written before the window holds nothing in it:
        // a file's mtime is never earlier than its last line's timestamp
        // unless something rewrote the mtime by hand, and a machine holding
        // hundreds of transcripts should not be read whole for a week's
        // window. Sorted order above makes "first cwd seen wins" stable.
        if (statSync(path).mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (err) {
        // Said, not swallowed: a transcript this runtime cannot read is a
        // session's time lost, and silence here is the failure.
        logRefusal(`backfill\t${path}\tcould not be read, skipped: ${errorMessage(err)}`);
        continue;
      }
      const fallbackId = file.replace(/\.jsonl$/, "");
      for (const line of text.split("\n")) {
        if (!line) continue;
        const ev = pickTranscriptEvent(line);
        if (!ev) continue;
        if (ev.t < sinceMs || ev.t >= untilMs) continue;
        const id = ev.sessionId ?? fallbackId;
        let session = sessions.get(id);
        if (!session) {
          session = { sessionId: id, cwd: null, events: [] };
          sessions.set(id, session);
        }
        if (session.cwd === null && ev.cwd) session.cwd = ev.cwd;
        session.events.push(ev);
      }
    }
  }
  return [...sessions.values()];
}

export interface BackfillPlan {
  sessions: number;
  runs: SpoolItem[];
  unmapped: number;
  /** Sessions left alone because they are still moving — named, so a
   *  withheld session is never a silent gap in "runs found". */
  skipped: string[];
}

/** True when the hooks are still writing marks for the session on this
 *  machine: its `.marks` file moved inside the idle cap. A `.meta.json`
 *  alone is not that — a session killed hard leaves one behind until the
 *  weekly prune, and its lost time is exactly what the backfill is for. */
export function hooksSessionMoving(sessionId: string, nowMs: number, idleCapMs: number): boolean {
  try {
    const marks = `${stateBase("claude", sessionId)}.marks`;
    if (!existsSync(marks)) return false;
    return nowMs - statSync(marks).mtimeMs < idleCapMs;
  } catch {
    return false;
  }
}

export function planBackfill(sessions: readonly BackfillSession[], idleCapSeconds: number, createdIso = nowIso(), nowMs = Date.now(), liveSession: (sessionId: string, nowMs: number, idleCapMs: number) => boolean = hooksSessionMoving): BackfillPlan {
  const runs: SpoolItem[] = [];
  const skipped: string[] = [];
  const idleCapMs = idleCapSeconds * 1000;
  let unmapped = 0;
  for (const session of sessions) {
    if (session.events.length === 0) continue;
    // A session still moving inside the idle cap, or one the hooks are
    // writing marks for, is being recorded live: the backfill must not land
    // first and leave the hooks' own run badged as reconstructed. It is
    // named in the plan, not dropped: the user runs backfill again later.
    const newest = session.events.reduce((m, e) => (e.t > m ? e.t : m), 0);
    if (nowMs - newest < idleCapMs || liveSession(session.sessionId, nowMs, idleCapMs)) {
      skipped.push(session.sessionId);
      continue;
    }
    const marks = marksFromTranscriptEvents(session.events);
    const cwd = session.cwd ?? "";
    let repoKey: string | null = null;
    if (cwd) {
      try {
        repoKey = existsSync(cwd) ? repoKeyFromRemote(gitRemote(cwd)) : null;
      } catch {
        repoKey = null;
      }
    }
    const segmented = segmentRuns(marks, idleCapSeconds);
    // A key that is not owner/repo (a local-path remote) names no project either.
    if (segmented.length > 0 && (repoKey === null || !REPO_KEY_SHAPE.test(repoKey))) unmapped += 1;
    for (const run of segmented) {
      runs.push({
        agent: "claude",
        label: AGENT_LABELS.claude,
        session: session.sessionId,
        cwd,
        repo_key: repoKey,
        start_time: run.start,
        end_time: run.end,
        agent_runtime_min: run.runtimeMin,
        agent_wait_min: run.waitMin,
        marks: run.marks,
        // Its own namespace: a live run of the same session keyed on the
        // same start instant is the same minutes, and the coverage check at
        // delivery settles that; the key must not replay the live entry.
        idempotency_key: `backfill:${session.sessionId}:${run.start}`,
        session_ref: session.sessionId,
        created: createdIso,
        backfilled: true,
      });
    }
  }
  return { sessions: sessions.length, runs, unmapped, skipped };
}

export function formatBackfillPlan(plan: BackfillPlan, opts: Pick<BackfillOptions, "sinceMs" | "untilMs" | "dryRun">): string {
  const minutes = plan.runs.reduce((sum, r) => sum + Math.round((Date.parse(r.end_time) - Date.parse(r.start_time)) / 60000), 0);
  const lines = [
    `backfill: ${new Date(opts.sinceMs).toISOString().slice(0, 10)} → ${new Date(opts.untilMs).toISOString().slice(0, 10)}${opts.dryRun ? " (dry run — nothing written)" : ""}`,
    `  sessions with activity: ${plan.sessions}`,
    `  runs found: ${plan.runs.length} (${minutes} min of active time, idle gaps excluded)`,
    `  runs on a directory no project names: ${plan.unmapped} session(s) — they will be refused as unmapped and written to the refusals log`,
    `  skipped as still moving: ${plan.skipped.length} session(s) — inside the idle cap, or the hooks are writing marks for them; run backfill again after they end`,
  ];
  for (const r of plan.runs.slice(0, 200)) {
    // A path-shaped key is a working directory by another name (SAL-192):
    // printed as (local), never as itself — stdout inside a session lands in
    // that session's transcript.
    const shown = r.repo_key && REPO_KEY_SHAPE.test(r.repo_key) ? r.repo_key : r.repo_key ? "(local)" : "(unmapped)";
    lines.push(`  ${r.start_time}  ${r.end_time}  ${String(r.agent_runtime_min ?? 0).padStart(4)}m working ${String(r.agent_wait_min ?? 0).padStart(4)}m waiting  ${shown}`);
  }
  if (plan.runs.length > 200) lines.push(`  … and ${plan.runs.length - 200} more`);
  return lines.join("\n");
}

/**
 * `backfill [--since=YYYY-MM-DD] [--until=YYYY-MM-DD] [--dry-run]
 * [--transcripts=DIR]` — reconstruct runs from this machine's Claude Code
 * transcripts and spool them like live runs, marked backfilled. Prints
 * the plan; with --dry-run, prints and stops.
 */
export async function cmdBackfill(argv: readonly string[], cfg: Config): Promise<void> {
  const opts = backfillOptions(argv);
  const sessions = readTranscriptSessions(opts.transcriptsDir, opts.sinceMs, opts.untilMs);
  const plan = planBackfill(sessions, cfg.idleCapSeconds);
  process.stdout.write(`${formatBackfillPlan(plan, opts)}\n`);
  if (opts.dryRun) return;
  // A withheld session is a line in the refusals log, like every other
  // minute this runtime declines to post.
  for (const id of plan.skipped) logRefusal(`backfill\t${id}\tskipped: still moving inside the idle cap; run backfill again after it ends`);
  if (plan.runs.length === 0) return;
  const dir = spoolDir();
  let spooled = 0;
  for (const item of plan.runs) {
    // The session id came from a transcript line, verbatim; the live path
    // sanitizes it for the same reason (stateBase). Never a path.
    const safe = String(item.session).replace(/[^A-Za-z0-9._-]/g, "_");
    try {
      writeAtomic(join(dir, `claude-backfill-${safe}-${item.start_time.replace(/[^0-9TZ]/g, "")}.json`), JSON.stringify(item), 0o600);
      spooled += 1;
    } catch (err) {
      logRefusal(`backfill\t${item.session}\t${item.start_time}\tcould not be spooled: ${errorMessage(err)}`);
    }
  }
  // Flush even when nothing new spooled: a full spool directory still holds
  // earlier runs, and this sweep is as good as any.
  process.stdout.write(`  spooled ${spooled} run(s); delivering now — a window an entry already covers is skipped, and anything refused is in the refusals log.\n`);
  await cmdFlush(cfg);
}

/** The interactive commands: errors reach the terminal and the exit code. */
const INTERACTIVE = new Set(["install", "doctor", "backfill"]);

export async function main(argv: readonly string[]): Promise<void> {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const [first, second, third] = positional;
  const cfg = readConfig();
  if (first === "flush") return cmdFlush(cfg);
  if (first === "doctor") return cmdDoctor(argv);
  if (first === "backfill") return cmdBackfill(argv, cfg);
  if (first === "install") {
    const uninstall = argv.includes("--uninstall");
    const apiUrl = installOrigin(argv);
    const changed = cmdInstall(second, { apiUrl, uninstall });
    const notes = uninstall ? [] : postInstallNotes(second);
    process.stdout.write(
      `shyre: ${uninstall ? "removed from" : "configured"} ${second ?? ""}${uninstall ? "" : ` — API origin ${apiUrl}`}\n${changed.length ? changed.map((p) => `  ${p}`).join("\n") : "  (nothing to change)"}\n` +
        (notes.length ? `\nNext:\n${notes.map((n) => `  - ${n}`).join("\n")}\n` : ""),
    );
    return;
  }
  if (first === undefined || !isAgent(first)) return;
  const payload = readStdin();
  if (second === "start") return cmdStart(first, payload);
  if (second === "beat") return cmdBeat(first, payload, third || "tool");
  if (second === "end") return cmdEnd(first, payload, cfg);
}

/**
 * Am I the script Node was asked to run? Compared through realpath: a
 * symlinked install (an npm bin link, a Homebrew shim) makes `argv[1]` the
 * link while `import.meta.url` is the target, and a plain string compare
 * would silently never run `main`.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== "string") return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const interactive = INTERACTIVE.has(process.argv[2] ?? "");
  main(process.argv.slice(2))
    .catch((err: unknown) => {
      const message = errorMessage(err);
      if (interactive) {
        process.stderr.write(`shyre: ${message}\n`);
        process.exitCode = 1;
      } else {
        // A hook must never fail the session: record it, exit 0.
        logRefusal(`internal: ${err instanceof Error ? err.stack || message : message}`);
      }
    })
    .finally(() => {
      if (!interactive) process.exitCode = 0;
    });
}
