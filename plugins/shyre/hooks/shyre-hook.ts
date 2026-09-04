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
 * • One entry per RUN of activity, with real timestamps. The shell kit posted
 *   `[session start, session start + active]`, which for a multi-day session
 *   fabricated one contiguous window on day one. A run is a stretch of marks
 *   with no gap over the idle cap; each run becomes one entry with its true
 *   start and end. Nothing is bridged, nothing is invented.
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
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VERSION = "1.0.2";

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
  created?: string;
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
}

/** The nine fields the server receives, and nothing else. */
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
}

type Env = Record<string, string | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function shyreHome(): string {
  return process.env.SHYRE_HOME || join(homedir(), ".shyre");
}

export const DEFAULT_API_URL = "https://shyre.malcom.io";

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
  return { apiKey, apiUrl, idleCapSeconds: Number.isFinite(cap) && cap > 0 ? cap : 900 };
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
      });
    }
    i = j + 1;
  }
  return runs;
}

/** The nine fields the server receives, and nothing else. */
export function buildEntryBody(item: EntryBodyInput): EntryBody {
  return {
    project_id: item.project_id,
    start_time: item.start_time,
    end_time: item.end_time,
    description: `${item.label} session — active time (idle gaps excluded); see transcript`,
    agent_label: item.label,
    session_ref: item.session_ref,
    idempotency_key: item.idempotency_key,
    agent_runtime_min: item.agent_runtime_min,
    agent_wait_min: item.agent_wait_min,
  };
}

/**
 * Does any existing entry overlap [start, end)? Mirrors the server's guard:
 * strict inequalities (touching windows are legal) and a running timer
 * (`end_time` null) reads as open through now. An entry with an unparseable
 * date is skipped; the server's guard is the backstop.
 */
export function windowCovered(entries: unknown, start: string, end: string, nowIso: string = new Date().toISOString()): boolean {
  const ws = Date.parse(start);
  const we = Date.parse(end);
  const now = Date.parse(nowIso);
  if (!Array.isArray(entries)) return false;
  return entries.some((e: unknown) => {
    if (!isRecord(e)) return false;
    const s = typeof e.start_time === "string" ? Date.parse(e.start_time) : Number.NaN;
    const en = typeof e.end_time === "string" ? Date.parse(e.end_time) : e.end_time ? Number.NaN : now;
    return Number.isFinite(s) && Number.isFinite(en) && s < we && en > ws;
  });
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

function writeAtomic(path: string, text: string, mode?: number): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  renameSync(tmp, path);
}

/**
 * Rewrite a file the USER owns: keep what was there. The first backup is the
 * pristine original and is never overwritten; later ones are timestamped, so
 * a second install cannot replace the original with its own first output.
 */
function writeUserFile(path: string, text: string): void {
  if (existsSync(path)) {
    try {
      const bak = existsSync(`${path}.bak`) ? `${path}.bak.${Date.now()}` : `${path}.bak`;
      writeFileSync(bak, readFileSync(path));
    } catch {
      /* a backup we could not take is not a reason to refuse the write */
    }
  }
  writeAtomic(path, text);
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

export function logRefusal(line: string): void {
  try {
    const target = process.env.SHYRE_HOOK_LOG || join(shyreHome(), "refusals.log");
    ensureDir(join(target, ".."));
    appendFileSync(target, `${new Date().toISOString()}\t${line}\n`);
    try {
      chmodSync(target, 0o600);
    } catch {
      /* not every filesystem honors modes */
    }
  } catch {
    /* logging must never throw */
  }
}

function gitRemote(cwd: string): string | null {
  try {
    return execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

function readMapFile(): unknown {
  for (const candidate of [join(shyreHome(), "projects.json"), join(homedir(), ".claude", "shyre-projects.json")]) {
    try {
      return JSON.parse(readFileSync(candidate, "utf8")) as unknown;
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

function readStdin(): unknown {
  try {
    if (process.stdin.isTTY) return {};
    const text = readFileSync(0, "utf8");
    return text.trim() ? (JSON.parse(text) as unknown) : {};
  } catch {
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
    child.unref();
  } catch {
    /* the spool is the durable record; a lost flush is retried next start */
  }
}

/** SessionStart. Appends when state already exists — compaction, resume. */
export function cmdStart(argvAgent: string, payload: unknown): void {
  const agent = detectAgent(argvAgent, payload);
  const { session, cwd } = normalizePayload(payload);
  if (!session) return;
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
  if (!session) return;
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
export function cmdEnd(argvAgent: string, payload: unknown, { idleCapSeconds }: Pick<Config, "idleCapSeconds">): void {
  const agent = detectAgent(argvAgent, payload);
  const { session } = normalizePayload(payload);
  if (!session) return;
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
      // Keyed on the run's START INSTANT, not its ordinal: a session id is
      // reused across /clear and --resume, so "run 1" would recur, and the
      // server would answer the second with the FIRST entry as a replay —
      // a 2xx that deleted the spool file and lost the hours silently.
      idempotency_key: `${session}:${run.start}`,
      session_ref: session,
      created: nowIso(),
    };
    writeAtomic(join(spoolDir(), `${agent}-${basename(base)}-${run.start.replace(/[^0-9TZ]/g, "")}.json`), JSON.stringify(item), 0o600);
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
    const rows = res.status === 200 ? toProjectRows(res.json) : null;
    // `|| -1`: no network reports status 0, which is falsy and would re-dial
    // (and re-wait the full timeout) for every item in the sweep.
    if (rows) projectsCache.list = rows;
    else projectsCache.failed = res.status || -1;
  }
  const list = projectsCache.list;
  if (!list) {
    const failed = projectsCache.failed ?? 0;
    return { id: null, reason: "lookup-failed", status: failed > 0 ? failed : 0 };
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

/**
 * Deliver one spool item. Returns true when the file can be removed:
 * posted, already covered, or refused for good. False keeps it for the next
 * sweep: no credential, no network, a redirect, a 5xx, or a refusal that a
 * token or rate-limit fix would clear.
 */
export async function deliver(item: SpoolItem, cfg: Config, projectsCache: ProjectsCache = {}): Promise<boolean> {
  if (!cfg.apiKey) return false;
  const tag = `${item.label}\t${item.repo_key || item.cwd}\t${item.start_time}..${item.end_time}`;
  const resolved = await resolveProject(item, cfg, projectsCache);
  if (resolved.id === null) {
    if (resolved.reason === "lookup-failed") {
      logRefusal(`${tag}\tprojects lookup failed (${resolved.status || "no network"}), kept for retry`);
      return false;
    }
    logRefusal(`${tag}\tunmapped: no map line and no project names this repo`);
    return true;
  }
  const projectId = resolved.id;
  const since = new Date(Date.parse(item.start_time) - 86400 * 1000).toISOString();
  const listUrl = `${cfg.apiUrl}/api/v1/entries?project_id=${encodeURIComponent(projectId)}&limit=100&since=${encodeURIComponent(since)}`;
  const list = await http("GET", listUrl, { apiKey: cfg.apiKey, agent: item.agent, session: item.session });
  if (list.status === 200 && windowCovered(list.json, item.start_time, item.end_time)) {
    logRefusal(`${tag}\tcovered: stood down, this window was already logged`);
    return true;
  }
  if (list.status !== 200) {
    logRefusal(`${tag}\tcoverage check answered ${list.status || "no network"}; posting without it`);
  }
  let start = item.start_time;
  let trimmed = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // A trimmed window no longer matches the meters computed for the whole
    // run, and a partial meter would break the "runtime + wait == active"
    // identity the entry is documented to satisfy — so a trimmed entry
    // carries no meters at all rather than wrong ones.
    const body = buildEntryBody({
      project_id: projectId,
      label: item.label,
      start_time: start,
      end_time: item.end_time,
      session_ref: item.session_ref,
      idempotency_key: item.idempotency_key,
      agent_runtime_min: trimmed ? undefined : item.agent_runtime_min,
      agent_wait_min: trimmed ? undefined : item.agent_wait_min,
    });
    const res = await http("POST", `${cfg.apiUrl}/api/v1/entries`, {
      apiKey: cfg.apiKey,
      agent: item.agent,
      session: item.session,
      body,
    });
    if (res.status >= 200 && res.status < 300) {
      // A 2xx whose body is not the entry (an HTML page from something in
      // front of the API) is not a success.
      if (isRecord(res.json)) return true;
      logRefusal(`${tag}\t${res.status} without an entry body, kept for retry`);
      return false;
    }
    if (res.status === 409 && attempt === 0) {
      const free = earliestFreeStart(isRecord(res.json) ? res.json.message : undefined);
      if (free && Date.parse(free) > Date.parse(start) && Date.parse(item.end_time) - Date.parse(free) >= 60000) {
        start = free;
        trimmed = true;
        continue;
      }
    }
    if (isFinalRefusal(res.status)) {
      logRefusal(`${tag}\t${res.status}\t${res.text.replace(/\s+/g, " ").slice(0, 400)}`);
      return true;
    }
    logRefusal(`${tag}\t${res.status || "no network"}\tkept for retry`);
    return false;
  }
  return false;
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
  };
}

/** Sweep the spool, then the leftovers. Runs detached; never prints. */
export async function cmdFlush(cfg: Config): Promise<void> {
  const dir = spoolDir();
  const cache: ProjectsCache = {};
  const dayAgo = Date.now() - 86400 * 1000;
  const weekAgo = Date.now() - 7 * 86400 * 1000;
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
      if (stat.mtimeMs < weekAgo) {
        logRefusal(`${name}\tpruned: undeliverable for 7 days`);
        unlinkSync(path);
        continue;
      }
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
        logRefusal(`${name}\tshape not recognized by runtime ${VERSION}, kept`);
        continue;
      }
      if (await deliver(item, cfg, cache)) unlinkSync(path);
    } catch (err) {
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
and stand down when your entry already covers the window.
`;

function upsertBlock(path: string, block: string, marker: string): boolean {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.includes(marker)) return false;
  writeUserFile(path, `${existing.trimEnd()}${existing ? "\n\n" : ""}${block}`);
  return true;
}

export function installCodex(home: string = homedir(), scriptPath: string): string[] {
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
    const block = `\n[mcp_servers.shyre]\nurl = "${readConfig().apiUrl}/api/mcp"\nbearer_token_env_var = "SHYRE_API_KEY"\n`;
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

export function installCursor(home: string = homedir(), scriptPath: string): string[] {
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
      url: `${readConfig().apiUrl}/api/mcp`,
      headers: { Authorization: "Bearer ${SHYRE_API_KEY}" },
    };
    writeUserFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
    changed.push(mcpPath);
  }
  const rules = ensureDir(join(dir, "rules"));
  const rulePath = join(rules, "shyre.mdc");
  if (!existsSync(rulePath)) {
    writeAtomic(rulePath, `---\ndescription: Log your own time to Shyre\nalwaysApply: true\n---\n\n${CONVENTION}`);
    changed.push(rulePath);
  }
  return changed;
}

export function cmdInstall(agent: string | undefined): string[] {
  const scriptPath = installRuntimeCopy();
  if (agent === "codex") return installCodex(homedir(), scriptPath);
  if (agent === "cursor") return installCursor(homedir(), scriptPath);
  if (agent === "claude") {
    throw new Error("Claude Code installs through the plugin: claude plugin install shyre@theshyre");
  }
  throw new Error(`no installer for "${agent ?? ""}" yet (supported: codex, cursor; Claude Code uses the plugin)`);
}

function cmdDoctor(): void {
  const cfg = readConfig();
  const configPath = join(shyreHome(), "config.json");
  let configNote = "none";
  if (existsSync(configPath)) {
    const mode = statSync(configPath).mode & 0o777;
    configNote = mode & 0o077 ? `present — WARNING: mode ${mode.toString(8)} is readable by others; chmod 600 it` : "present, mode 600";
  }
  const spoolItems = readdirSync(spoolDir()).filter((n) => n.endsWith(".json"));
  const oldest = spoolItems.reduce((acc, n) => Math.min(acc, statSync(join(spoolDir(), n)).mtimeMs), Date.now());
  const lines = [
    `shyre-hook ${VERSION}`,
    `home: ${shyreHome()}`,
    `api: ${cfg.apiUrl}`,
    // Only the prefix and four characters: doctor output ends up in issues.
    `token: ${cfg.apiKey ? `present (${cfg.apiKey.slice(0, 14)}…)` : "MISSING — export SHYRE_API_KEY or write ~/.shyre/config.json"}`,
    `config file: ${configNote}`,
    `idle cap: ${cfg.idleCapSeconds}s`,
    `map: ${readMapFile() ? "found" : "none (server github_repo fallback only)"}`,
    `spool: ${spoolItems.length} pending${spoolItems.length ? ` (oldest ${Math.round((Date.now() - oldest) / 3600000)} h; pruned after 7 days)` : ""}`,
    `sessions: ${readdirSync(sessionsDir()).filter((n) => n.endsWith(".meta.json")).length} open`,
    `tmpdir (legacy shell kit state, not used): ${tmpdir()}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The interactive commands: errors reach the terminal and the exit code. */
const INTERACTIVE = new Set(["install", "doctor"]);

export async function main(argv: readonly string[]): Promise<void> {
  const [first, second, third] = argv;
  const cfg = readConfig();
  if (first === "flush") return cmdFlush(cfg);
  if (first === "doctor") return cmdDoctor();
  if (first === "install") {
    const changed = cmdInstall(second);
    const notes = postInstallNotes(second);
    process.stdout.write(
      `shyre: configured ${second ?? ""}\n${changed.map((p) => `  ${p}`).join("\n")}\n` +
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
