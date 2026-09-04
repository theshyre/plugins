#!/usr/bin/env node
// Shyre agent-session logger — ONE runtime for every coding agent.
//
// Runs on the agent's lifecycle hooks and records a time entry for each run
// of activity in a session. No jq, no bash, no PowerShell port: plain Node
// (18+), the same file on macOS, Linux and Windows, shipped inside the Claude
// Code plugin and installed for other agents by `install <agent>`.
//
//   node shyre-hook.mjs <agent> start            SessionStart
//   node shyre-hook.mjs <agent> beat <tag>       tool | stop | prompt
//   node shyre-hook.mjs <agent> end              SessionEnd
//   node shyre-hook.mjs flush                    deliver whatever is spooled
//   node shyre-hook.mjs install <agent>          write that agent's config
//   node shyre-hook.mjs doctor                   print what it can see
//
// The hook payload (JSON) arrives on stdin. Never blocks and never fails a
// session: every path swallows its own errors and exits 0.
//
// ⚠️ WHAT THIS FIXES, AND WHY EACH ONE IS SHAPED AS IT IS.
//
// • Compaction no longer discards the session. Claude Code fires SessionStart
//   again after context compaction with the SAME session id; the shell kit's
//   `start` truncated the state file, so everything before the compaction was
//   thrown away (a 13-hour session logged 91 minutes). `start` here APPENDS a
//   mark when state already exists.
//
// • One entry per RUN of activity, with real timestamps. The shell kit posted
//   `[session start, session start + active]`, which for a multi-day session
//   fabricated one contiguous window on day one. A run is a stretch of marks
//   with no gap over the idle cap; each run becomes one entry with its true
//   start and end. Nothing is bridged, nothing is invented.
//
// • SessionEnd does no network. Claude Code gives SessionEnd hooks 1.5 s
//   shared; Codex gives 1 s and ignores `async`. `end` writes spool files and
//   returns; a detached `flush` delivers them, and the next `start` sweeps
//   whatever that attempt could not land. State lives under ~/.shyre, not
//   $TMPDIR, so a reboot does not empty the spool.
//
// • A refusal, a stand-down and an unmapped repo are all written to
//   ~/.shyre/refusals.log with the server's reason. Nothing is discarded in
//   silence.
//
// • An overlap refusal that names an earliest free start is retried ONCE with
//   the window trimmed to it — the fix the server attaches to the 409.
//
// • The repo → project map is looked up case-insensitively, then falls back to
//   the server: `GET /api/v1/projects` returns each project's `github_repo`,
//   so a repo whose project names it needs no local map line at all.
//
// • Both meters (agent_runtime_min / agent_wait_min) are computed from the
//   beat tags: a gap that STARTS at `stop` is the agent waiting on the human;
//   any other gap is the machine working. runtime + wait == active, exactly.

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

/** @typedef {{ t: number, k: string }} Mark */
/** @typedef {{ start: string, end: string, runtimeMin: number, waitMin: number, index: number }} Run */
/** @typedef {{ agent: string, label: string, session: string, cwd: string, repoKey: string | null }} Meta */

export const VERSION = "1.0.0";

/** Agent id → what the entry's `agent_label` says. */
export const AGENT_LABELS = Object.freeze({
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  copilot: "Copilot CLI",
  opencode: "OpenCode",
});

/**
 * Every hook event each agent wires, and the tag the runtime receives for it.
 * `start` and `end` are lifecycle; the rest are beats. This table is what the
 * Claude plugin's hooks.json and every installer are generated from, so one
 * agent cannot drift from another (the PowerShell port once wired only Stop).
 */
export const HOOK_WIRING = Object.freeze({
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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function shyreHome() {
  return process.env.SHYRE_HOME || join(homedir(), ".shyre");
}

/**
 * Token and URL: the environment first, then ~/.shyre/config.json. The file
 * exists because Codex's `shell_environment_policy` may strip `*KEY*` names
 * from the environment a hook sees, and because a token in a 600 file is no
 * worse than a token in a shell profile.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function readConfig(env = process.env) {
  /** @type {{ api_key?: string, api_url?: string, idle_cap_seconds?: number }} */
  let file = {};
  try {
    file = JSON.parse(readFileSync(join(shyreHome(), "config.json"), "utf8"));
  } catch {
    file = {};
  }
  const apiKey = env.SHYRE_API_KEY || file.api_key || "";
  const apiUrl = validApiUrl(env.SHYRE_API_URL || file.api_url) || DEFAULT_API_URL;
  const cap = Number(env.SHYRE_IDLE_CAP_SECONDS || file.idle_cap_seconds || 900);
  return { apiKey, apiUrl, idleCapSeconds: Number.isFinite(cap) && cap > 0 ? cap : 900 };
}

export const DEFAULT_API_URL = "https://shyre.malcom.io";

/**
 * The API origin is written into the user's MCP configs and receives the
 * bearer token, so it is validated before either: https only (plain http on
 * localhost for development), a parseable URL, no credentials, no path, and
 * nothing outside the URL character set that would break a TOML string.
 * Anything else falls back to the default and is recorded.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
export function validApiUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let url;
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

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * `git@github.com:Owner/Repo.git` / `https://github.com/owner/repo/` →
 * `owner/repo`. Lower-cased: GitHub is case-insensitive and the remote's
 * casing is whatever was cloned (a `Malcom-IO/quillquest` remote missed a
 * `malcom-io/quillquest` map line for weeks).
 */
export function repoKeyFromRemote(remote) {
  if (!remote) return null;
  const key = String(remote)
    .trim()
    .replace(/^[a-z+]+:\/\/[^/]+\//i, "")
    .replace(/^[^@]+@[^:]+:/, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  return key ? key.toLowerCase() : null;
}

/**
 * The hook payload differs per agent. Claude/Codex/Gemini: `session_id` +
 * `cwd`; Cursor: `conversation_id` + `workspace_roots[0]`; Copilot:
 * `sessionId`; OpenCode: `sessionID` + `directory`.
 *
 * @param {unknown} raw
 * @param {Record<string, string | undefined>} [env]
 */
export function normalizePayload(raw, env = process.env) {
  const p = raw && typeof raw === "object" ? raw : {};
  const session =
    p.session_id || p.sessionId || p.conversation_id || p.sessionID || p.session || null;
  const roots = Array.isArray(p.workspace_roots) ? p.workspace_roots : [];
  const cwd = p.cwd || p.directory || roots[0] || env.CURSOR_PROJECT_DIR || process.cwd();
  return { session: session ? String(session) : null, cwd: String(cwd), source: p.source || p.reason || null };
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
 *
 * @param {string} argvAgent
 * @param {unknown} raw
 */
export function detectAgent(argvAgent, raw) {
  const p = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  if (p.cursor_version !== undefined || p.conversation_id !== undefined || Array.isArray(p.workspace_roots)) {
    return "cursor";
  }
  const transcript = typeof p.transcript_path === "string" ? p.transcript_path : "";
  if (/[\\/]\.codex[\\/]/.test(transcript)) return "codex";
  if (/[\\/]\.claude[\\/]/.test(transcript)) return "claude";
  if (p.sessionId !== undefined && p.session_id === undefined) return "copilot";
  if (p.sessionID !== undefined && p.directory !== undefined) return "opencode";
  return argvAgent in AGENT_LABELS ? argvAgent : "claude";
}

/** Parse a marks file: one `ISO tag` per line; blank or malformed lines dropped. */
export function parseMarks(text) {
  /** @type {Mark[]} */
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(\S+)(?:\s+(\S+))?\s*$/.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (!Number.isFinite(t)) continue;
    out.push({ t, k: m[2] || "tool" });
  }
  return out;
}

/**
 * Split marks into runs at gaps over the idle cap, and compute the meters
 * per run. A run under 60 s of activity is dropped. A gap is charged to
 * `wait` when it STARTS at a `stop` mark (the agent had finished its turn and
 * was blocked on the human) and to `runtime` otherwise. Runs longer than
 * 23 h are cut so no entry can exceed the server's 24 h maximum.
 *
 * @param {Mark[]} marks
 * @param {number} capSeconds
 * @returns {Run[]}
 */
export function segmentRuns(marks, capSeconds) {
  const sorted = [...marks].sort((a, b) => a.t - b.t);
  /** @type {Run[]} */
  const runs = [];
  const capMs = capSeconds * 1000;
  const maxRunMs = 23 * 3600 * 1000;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    let runtime = 0;
    let wait = 0;
    while (j + 1 < sorted.length) {
      const gap = sorted[j + 1].t - sorted[j].t;
      if (gap > capMs) break;
      if (sorted[j + 1].t - sorted[i].t > maxRunMs) break;
      if (sorted[j].k === "stop") wait += gap;
      else runtime += gap;
      j += 1;
    }
    const active = runtime + wait;
    if (active >= 60 * 1000) {
      runs.push({
        start: new Date(sorted[i].t).toISOString().replace(/\.\d{3}Z$/, "Z"),
        end: new Date(sorted[j].t).toISOString().replace(/\.\d{3}Z$/, "Z"),
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
export function buildEntryBody(item) {
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
 * (`end_time` null) reads as open through now.
 */
export function windowCovered(entries, start, end, nowIso = new Date().toISOString()) {
  const ws = Date.parse(start);
  const we = Date.parse(end);
  const now = Date.parse(nowIso);
  return (Array.isArray(entries) ? entries : []).some((e) => {
    const s = Date.parse(e.start_time);
    const en = e.end_time ? Date.parse(e.end_time) : now;
    return Number.isFinite(s) && Number.isFinite(en) && s < we && en > ws;
  });
}

/** The ISO instant an overlap refusal names as the earliest legal start, if any. */
export function earliestFreeStart(message) {
  const m = /earliest free start is (\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/i.exec(
    String(message || ""),
  );
  return m ? m[1] : null;
}

/** Case-insensitive lookup of a repo key in a map object, else `_default`. */
export function resolveFromMap(map, repoKey) {
  if (!map || typeof map !== "object") return null;
  if (repoKey) {
    for (const [k, v] of Object.entries(map)) {
      if (k.startsWith("_")) continue;
      if (k.toLowerCase() === repoKey && typeof v === "string" && v) return v;
    }
  }
  return typeof map._default === "string" && map._default ? map._default : null;
}

// ---------------------------------------------------------------------------
// Local files
// ---------------------------------------------------------------------------

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}

/** Our own state directories: the marks and spool name projects, working
 *  windows and absolute paths, and config.json may hold the token. 0700. */
function ensurePrivateDir(p) {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  try {
    chmodSync(p, 0o700);
  } catch {
    /* not every filesystem honors modes */
  }
  return p;
}

function writeAtomic(path, text, mode) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  renameSync(tmp, path);
}

/**
 * Rewrite a file the USER owns: keep what was there. The first backup is the
 * pristine original and is never overwritten; later ones are timestamped, so
 * a second install cannot replace the original with its own first output.
 */
function writeUserFile(path, text) {
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

function sessionsDir() {
  ensurePrivateDir(shyreHome());
  return ensurePrivateDir(join(shyreHome(), "sessions"));
}

function spoolDir() {
  ensurePrivateDir(shyreHome());
  return ensurePrivateDir(join(shyreHome(), "spool"));
}

function stateBase(agent, session) {
  const safe = String(session).replace(/[^A-Za-z0-9._-]/g, "_");
  return join(sessionsDir(), `${agent}-${safe}`);
}

export function logRefusal(line) {
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

function gitRemote(cwd) {
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

function readMapFile() {
  for (const candidate of [
    join(shyreHome(), "projects.json"),
    join(homedir(), ".claude", "shyre-projects.json"),
  ]) {
    try {
      return JSON.parse(readFileSync(candidate, "utf8"));
    } catch {
      /* try the next */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function http(method, url, { apiKey, agent, session, body }) {
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
        "X-Agent-Label": AGENT_LABELS[agent] || agent,
        "X-Session-Ref": session,
        "User-Agent": `shyre-hook/${VERSION}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  } catch (err) {
    return { status: 0, json: null, text: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return {};
    const text = readFileSync(0, "utf8");
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function detachedFlush() {
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
export function cmdStart(argvAgent, payload) {
  const agent = detectAgent(argvAgent, payload);
  const { session, cwd } = normalizePayload(payload);
  if (!session) return;
  const base = stateBase(agent, session);
  if (!existsSync(`${base}.meta.json`)) {
    const remote = gitRemote(cwd);
    /** @type {Meta} */
    const meta = {
      agent,
      label: AGENT_LABELS[agent] || agent,
      session,
      cwd,
      repoKey: repoKeyFromRemote(remote),
    };
    writeAtomic(`${base}.meta.json`, JSON.stringify(meta), 0o600);
  }
  appendFileSync(`${base}.marks`, `${nowIso()} start\n`, { mode: 0o600 });
  detachedFlush();
}

/** A beat. Creates state on the fly when SessionStart never fired. */
export function cmdBeat(argvAgent, payload, tag) {
  const agent = detectAgent(argvAgent, payload);
  const { session } = normalizePayload(payload);
  if (!session) return;
  const base = stateBase(agent, session);
  if (!existsSync(`${base}.meta.json`)) cmdStart(agent, payload);
  const k = ["tool", "stop", "prompt"].includes(tag) ? tag : "tool";
  appendFileSync(`${base}.marks`, `${nowIso()} ${k}\n`, { mode: 0o600 });
}

/** SessionEnd. Spools one item per run; no network. A second source firing
 *  the same end (Cursor + the Claude plugin) finds no state and does nothing. */
export function cmdEnd(argvAgent, payload, { idleCapSeconds }) {
  const agent = detectAgent(argvAgent, payload);
  const { session } = normalizePayload(payload);
  if (!session) return;
  const base = stateBase(agent, session);
  if (!existsSync(`${base}.meta.json`)) return;
  /** @type {Meta | null} */
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(`${base}.meta.json`, "utf8"));
  } catch (err) {
    logRefusal(`${basename(base)}\tunreadable session meta, marks left in place: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!meta || typeof meta !== "object") return;
  let marksText = "";
  try {
    marksText = readFileSync(`${base}.marks`, "utf8");
  } catch {
    marksText = "";
  }
  const runs = segmentRuns(parseMarks(marksText), idleCapSeconds);
  for (const run of runs) {
    const item = {
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
    writeAtomic(
      join(spoolDir(), `${agent}-${basename(base)}-${run.start.replace(/[^0-9TZ]/g, "")}.json`),
      JSON.stringify(item),
      0o600,
    );
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

/**
 * Resolve the project for a spool item: the local map, then the server's
 * `github_repo` across EVERY lifecycle status (a completed fixed-bid project
 * still gets warranty sessions). Three answers, and they must stay distinct:
 * an id; `unmapped` (the server answered and nothing names this repo); and
 * `lookup-failed` (the server did not answer — revoked token, 429, outage).
 * The first version folded the third into the second and DELETED the entry
 * with "no project names this repo" as the reason; the codebase's own rule
 * is that an empty result is not a fact.
 *
 * @returns {Promise<{ id: string } | { id: null, reason: "unmapped" | "lookup-failed", status?: number }>}
 */
async function resolveProject(item, cfg, projectsCache) {
  const fromMap = resolveFromMap(readMapFile(), item.repo_key);
  if (fromMap) return { id: fromMap };
  if (!item.repo_key) return { id: null, reason: "unmapped" };
  if (!projectsCache.list && !projectsCache.failed) {
    const res = await http("GET", `${cfg.apiUrl}/api/v1/projects?status=all`, {
      apiKey: cfg.apiKey,
      agent: item.agent,
      session: item.session,
    });
    if (res.status === 200 && Array.isArray(res.json)) projectsCache.list = res.json;
    // `|| -1`: no network reports status 0, which is falsy and would re-dial
    // (and re-wait the full timeout) for every item in the sweep.
    else projectsCache.failed = res.status || -1;
  }
  if (!projectsCache.list) {
    return { id: null, reason: "lookup-failed", status: projectsCache.failed > 0 ? projectsCache.failed : 0 };
  }
  const hit = projectsCache.list.find(
    (p) => typeof p.github_repo === "string" && p.github_repo.toLowerCase() === item.repo_key,
  );
  return hit ? { id: hit.id } : { id: null, reason: "unmapped" };
}

/** Statuses after which the same request would be refused again. */
function isFinalRefusal(status) {
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
export async function deliver(item, cfg, projectsCache = {}) {
  if (!cfg.apiKey) return false;
  const tag = `${item.label}\t${item.repo_key || item.cwd}\t${item.start_time}..${item.end_time}`;
  const resolved = await resolveProject(item, cfg, projectsCache);
  if (!resolved.id) {
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
      ...item,
      project_id: projectId,
      start_time: start,
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
      if (res.json && typeof res.json === "object" && !Array.isArray(res.json)) return true;
      logRefusal(`${tag}\t${res.status} without an entry body, kept for retry`);
      return false;
    }
    if (res.status === 409 && attempt === 0) {
      const free = earliestFreeStart(res.json && res.json.message);
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

/** Sweep the spool, then the leftovers. Runs detached; never prints. */
export async function cmdFlush(cfg) {
  const dir = spoolDir();
  const cache = {};
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
      if (statSync(path).mtimeMs < weekAgo) {
        logRefusal(`${name}\tpruned: undeliverable for 7 days`);
        unlinkSync(path);
        continue;
      }
      const item = JSON.parse(readFileSync(path, "utf8"));
      if (await deliver(item, cfg, cache)) unlinkSync(path);
    } catch (err) {
      logRefusal(`${name}\tunreadable: ${err instanceof Error ? err.message : String(err)}`);
      try {
        unlinkSync(path);
      } catch {
        /* gone */
      }
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
export function nodeCommand(scriptPath, agent, args) {
  if (!/^[A-Za-z0-9_./\\: -]+$/.test(scriptPath)) {
    throw new Error(`refusing to write a hook command for a path with shell-significant characters: ${scriptPath}`);
  }
  return `node "${scriptPath}" ${agent} ${args}`;
}

/** Copy this file to ~/.shyre/bin so agent configs point at a stable path. */
function installRuntimeCopy() {
  const bin = ensurePrivateDir(join(shyreHome(), "bin"));
  const target = join(bin, "shyre-hook.mjs");
  const self = selfPath();
  if (self !== target) writeAtomic(target, readFileSync(self, "utf8"));
  return target;
}

/** Where this file really is — through any symlink. */
function selfPath() {
  return fileURLToPath(import.meta.url);
}

/**
 * Read a JSON file the user owns. A file that exists but does not parse is
 * NOT treated as empty: the first version did, and `install` then replaced a
 * user's whole hooks file — their own shell-audit hook included — with only
 * ours, exit 0, no backup, no warning.
 */
function readUserJson(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${path} exists but is not valid JSON (${err instanceof Error ? err.message : String(err)}); fix or move it, then run install again — nothing was changed`,
    );
  }
}

/** Claude-shaped hooks.json (Claude Code and Codex share the schema). */
export function claudeShapedHooks(agent, scriptPath, timeouts = {}) {
  /** @type {Record<string, unknown[]>} */
  const hooks = {};
  for (const [event, args] of HOOK_WIRING[agent]) {
    const hook = { type: "command", command: nodeCommand(scriptPath, agent, args) };
    if (timeouts[event]) hook.timeout = timeouts[event];
    const entry = event === "PostToolUse" ? { matcher: ".*", hooks: [hook] } : { hooks: [hook] };
    hooks[event] = [entry];
  }
  return { hooks };
}

/** Cursor's hooks.json: `version: 1`, flat per-event arrays of `{ command }`. */
export function cursorHooks(scriptPath) {
  /** @type {Record<string, unknown[]>} */
  const hooks = {};
  for (const [event, args] of HOOK_WIRING.cursor) {
    hooks[event] = [{ command: nodeCommand(scriptPath, "cursor", args) }];
  }
  return { version: 1, hooks };
}

/** Is this hook entry one of ours — a `node … shyre-hook.mjs <agent> <verb>` command? */
// The quoted branch may contain spaces (`"C:\Users\John Smith\…"`); the
// first version could not match its own command on such a path and so
// duplicated every hook on each re-install.
const OURS = /\bnode\s+(?:"[^"]*shyre-hook\.mjs"|\S*shyre-hook\.mjs)\s+(?:claude|codex|cursor|gemini|copilot|opencode)\s+(?:start|beat|end)\b/;

function isOurEntry(entry) {
  const commands = [];
  if (entry && typeof entry === "object") {
    if (typeof entry.command === "string") commands.push(entry.command);
    if (Array.isArray(entry.hooks)) {
      for (const h of entry.hooks) if (h && typeof h.command === "string") commands.push(h.command);
    }
  }
  return commands.some((c) => OURS.test(c));
}

/** Merge our events into an existing hooks object; only entries that ARE
 *  ours are replaced. A user's wrapper that merely mentions our filename
 *  stays. */
function mergeHooks(existing, ours) {
  const out = existing && typeof existing === "object" ? { ...existing } : {};
  out.hooks = out.hooks && typeof out.hooks === "object" ? { ...out.hooks } : {};
  for (const [event, entries] of Object.entries(ours.hooks)) {
    const prev = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
    const kept = prev.filter((e) => !isOurEntry(e));
    out.hooks[event] = [...kept, ...entries];
  }
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

function upsertBlock(path, block, marker) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.includes(marker)) return false;
  writeUserFile(path, `${existing.trimEnd()}${existing ? "\n\n" : ""}${block}`);
  return true;
}

export function installCodex(home = homedir(), scriptPath) {
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
export const POST_INSTALL_NOTES = Object.freeze({
  codex: [
    "Open Codex and run /hooks to review and TRUST the shyre hooks — Codex skips untrusted hooks silently, and re-trusting is needed after any change to them.",
    "Codex hooks inherit your shell environment, so SHYRE_API_KEY exported there is enough; ~/.shyre/config.json is the fallback for shells that do not export it.",
  ],
  cursor: [
    "If the Claude Code plugin is installed too, Cursor loads it as well; the runtime detects the Cursor session from its payload and records it once, as Cursor.",
    "On Windows, Cursor delivers the hook payload through a POSIX heredoc, which cmd and PowerShell cannot parse; use WSL or Git Bash for cursor-agent there.",
  ],
});

export function installCursor(home = homedir(), scriptPath) {
  const dir = ensureDir(join(home, ".cursor"));
  const hooksPath = join(dir, "hooks.json");
  const mcpPath = join(dir, "mcp.json");
  // Read every file first, then write: "nothing was changed" must be true
  // when the second read is the one that refuses.
  const existingHooks = readUserJson(hooksPath);
  const mcp = readUserJson(mcpPath);
  const merged = mergeHooks(existingHooks, cursorHooks(scriptPath));
  writeUserFile(hooksPath, `${JSON.stringify(merged, null, 2)}\n`);
  mcp.mcpServers = mcp.mcpServers && typeof mcp.mcpServers === "object" ? mcp.mcpServers : {};
  const changed = [hooksPath];
  if (!mcp.mcpServers.shyre) {
    mcp.mcpServers.shyre = {
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

export function cmdInstall(agent) {
  const scriptPath = installRuntimeCopy();
  if (agent === "codex") return installCodex(homedir(), scriptPath);
  if (agent === "cursor") return installCursor(homedir(), scriptPath);
  if (agent === "claude") {
    throw new Error("Claude Code installs through the plugin: claude plugin install shyre@theshyre");
  }
  throw new Error(`no installer for "${agent}" yet (supported: codex, cursor; Claude Code uses the plugin)`);
}

function cmdDoctor() {
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
    `token: ${cfg.apiKey ? `present (${cfg.apiKey.slice(0, 16)}…)` : "MISSING — export SHYRE_API_KEY or write ~/.shyre/config.json"}`,
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

export async function main(argv) {
  const [first, second, third] = argv;
  const cfg = readConfig();
  if (first === "flush") return cmdFlush(cfg);
  if (first === "doctor") return cmdDoctor();
  if (first === "install") {
    const changed = cmdInstall(second);
    const notes = POST_INSTALL_NOTES[second] || [];
    process.stdout.write(
      `shyre: configured ${second}\n${changed.map((p) => `  ${p}`).join("\n")}\n` +
        (notes.length ? `\nNext:\n${notes.map((n) => `  - ${n}`).join("\n")}\n` : ""),
    );
    return;
  }
  const agent = first in AGENT_LABELS ? first : null;
  if (!agent) return;
  const payload = readStdin();
  if (second === "start") return cmdStart(agent, payload);
  if (second === "beat") return cmdBeat(agent, payload, third || "tool");
  if (second === "end") return cmdEnd(agent, payload, cfg);
}

/**
 * Am I the script Node was asked to run? Compared through realpath: a
 * symlinked install (an npm bin link, a Homebrew shim) makes `argv[1]` the
 * link while `import.meta.url` is the target, and a plain string compare
 * would silently never run `main`.
 */
function invokedDirectly() {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const interactive = INTERACTIVE.has(process.argv[2]);
  main(process.argv.slice(2))
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
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
