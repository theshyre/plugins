#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Malcom IO LLC. Licensed under the MIT License; see the
// LICENSE file published with this plugin at https://github.com/theshyre/plugins.
//
// GENERATED FILE — built from shyre-hook.ts by scripts/sync-hooks-runtime.mjs.
// Edit the TypeScript source; this file is overwritten on every build.

// plugins/shyre/hooks/shyre-hook.ts
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
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
var VERSION = "1.5.0";
var AGENT_LABELS = Object.freeze({
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  copilot: "Copilot CLI",
  opencode: "OpenCode"
});
function isAgent(value) {
  return Object.prototype.hasOwnProperty.call(AGENT_LABELS, value);
}
function labelFor(agent) {
  return isAgent(agent) ? AGENT_LABELS[agent] : agent;
}
var HOOK_WIRING = Object.freeze({
  claude: [
    ["SessionStart", "start"],
    ["UserPromptSubmit", "beat prompt"],
    ["PostToolUse", "beat tool"],
    ["SubagentStop", "beat tool"],
    ["Stop", "beat stop"],
    ["SessionEnd", "end"]
  ],
  codex: [
    ["SessionStart", "start"],
    ["UserPromptSubmit", "beat prompt"],
    ["PostToolUse", "beat tool"],
    ["SubagentStop", "beat tool"],
    ["Stop", "beat stop"],
    ["SessionEnd", "end"]
  ],
  cursor: [
    ["sessionStart", "start"],
    ["beforeSubmitPrompt", "beat prompt"],
    ["postToolUse", "beat tool"],
    ["subagentStop", "beat tool"],
    ["stop", "beat stop"],
    ["sessionEnd", "end"]
  ]
});
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var MAX_IDLE_CAP_SECONDS = 86400;
function shyreHome() {
  return process.env.SHYRE_HOME || join(homedir(), ".shyre");
}
var DEFAULT_API_URL = "https://shyre.io";
function validApiUrl(raw) {
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
function readConfig(env = process.env) {
  let file = {};
  try {
    const parsed = JSON.parse(readFileSync(join(shyreHome(), "config.json"), "utf8"));
    if (isRecord(parsed)) file = parsed;
  } catch {
    file = {};
  }
  const fileKey = typeof file.api_key === "string" ? file.api_key : "";
  const fileUrl = typeof file.api_url === "string" ? file.api_url : void 0;
  const fileCap = typeof file.idle_cap_seconds === "number" || typeof file.idle_cap_seconds === "string" ? file.idle_cap_seconds : void 0;
  const apiKey = env.SHYRE_API_KEY || fileKey;
  const apiUrl = validApiUrl(env.SHYRE_API_URL || fileUrl) || DEFAULT_API_URL;
  const cap = Number(env.SHYRE_IDLE_CAP_SECONDS || fileCap || 900);
  return { apiKey, apiUrl, idleCapSeconds: Number.isFinite(cap) && cap > 0 && cap <= MAX_IDLE_CAP_SECONDS ? cap : 900 };
}
function repoKeyFromRemote(remote) {
  if (!remote) return null;
  const key = String(remote).replace(/[\r\n\t]+/g, "").trim().replace(/^[a-z+]+:\/\/[^/]+\//i, "").replace(/^[^@]+@[^:]+:/, "").replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  return key ? key.toLowerCase() : null;
}
function firstString(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}
function normalizePayload(raw, env = process.env) {
  const p = isRecord(raw) ? raw : {};
  const session = firstString(p, ["session_id", "sessionId", "conversation_id", "sessionID", "session"]);
  const roots = Array.isArray(p.workspace_roots) ? p.workspace_roots : [];
  const firstRoot = typeof roots[0] === "string" ? roots[0] : null;
  const cwd = firstString(p, ["cwd", "directory"]) || firstRoot || env.CURSOR_PROJECT_DIR || process.cwd();
  return { session, cwd: String(cwd), source: firstString(p, ["source", "reason"]) };
}
function detectAgent(argvAgent, raw) {
  const p = isRecord(raw) ? raw : {};
  if (p.cursor_version !== void 0 || p.conversation_id !== void 0 || Array.isArray(p.workspace_roots)) {
    return "cursor";
  }
  const transcript = typeof p.transcript_path === "string" ? p.transcript_path : "";
  if (/[\\/]\.codex[\\/]/.test(transcript)) return "codex";
  if (/[\\/]\.claude[\\/]/.test(transcript)) return "claude";
  if (p.sessionId !== void 0 && p.session_id === void 0) return "copilot";
  if (p.sessionID !== void 0 && p.directory !== void 0) return "opencode";
  return isAgent(argvAgent) ? argvAgent : "claude";
}
function parseMarks(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(\S+)(?:\s+(\S+))?\s*$/.exec(line);
    if (!m || m[1] === void 0) continue;
    const t = Date.parse(m[1]);
    if (!Number.isFinite(t)) continue;
    out.push({ t, k: m[2] || "tool" });
  }
  return out;
}
function isoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function segmentRuns(marks, capSeconds) {
  const sorted = [...marks].sort((a, b) => a.t - b.t);
  const runs = [];
  const capMs = capSeconds * 1e3;
  const maxRunMs = 23 * 3600 * 1e3;
  let i = 0;
  while (i < sorted.length) {
    const first = sorted[i];
    if (!first) break;
    let j = i;
    let last = first;
    let runtime = 0;
    let wait = 0;
    for (; ; ) {
      const next = sorted[j + 1];
      if (!next) break;
      const gap = next.t - last.t;
      if (gap > capMs) break;
      if (next.t - first.t > maxRunMs) break;
      if (last.k === "stop") wait += gap;
      else runtime += gap;
      j += 1;
      last = next;
    }
    const active = runtime + wait;
    if (active >= 60 * 1e3) {
      runs.push({
        start: isoSeconds(first.t),
        end: isoSeconds(last.t),
        runtimeMin: Math.floor(runtime / 6e4),
        waitMin: Math.floor(wait / 6e4),
        index: runs.length + 1,
        marks: sorted.slice(i, j + 1)
      });
    }
    i = j + 1;
  }
  return runs;
}
function buildEntryBody(item) {
  return {
    project_id: item.project_id,
    start_time: item.start_time,
    end_time: item.end_time,
    description: item.backfilled ? `${item.label} session \u2014 backfilled from local history after the fact; active time (idle gaps excluded)` : `${item.label} session \u2014 active time (idle gaps excluded); see transcript`,
    agent_label: item.label,
    session_ref: item.session_ref,
    idempotency_key: item.idempotency_key,
    agent_runtime_min: item.agent_runtime_min,
    agent_wait_min: item.agent_wait_min,
    prompt_marks: item.prompt_marks,
    backfilled: item.backfilled === true,
    agent_tokens: item.agent_tokens ? { input: item.agent_tokens.input, output: item.agent_tokens.output, cache_read: item.agent_tokens.cache_read, cache_creation: item.agent_tokens.cache_creation } : void 0,
    agent_model: item.agent_tokens?.model,
    agent_cost_usd_list: item.agent_tokens?.cost_usd_list
  };
}
function uncoveredSegments(entries, start, end, nowIso2 = (/* @__PURE__ */ new Date()).toISOString()) {
  const ws = Date.parse(start);
  const we = Date.parse(end);
  const now = Date.parse(nowIso2);
  if (!Number.isFinite(ws) || !Number.isFinite(we) || we <= ws) return [];
  const covered = [];
  if (Array.isArray(entries)) {
    for (const e of entries) {
      if (!isRecord(e)) continue;
      const s = typeof e.start_time === "string" ? Date.parse(e.start_time) : Number.NaN;
      const en = typeof e.end_time === "string" ? Date.parse(e.end_time) : e.end_time ? Number.NaN : Math.min(now, s + 864e5);
      if (Number.isFinite(s) && Number.isFinite(en) && s < we && en > ws) covered.push([Math.max(s, ws), Math.min(en, we)]);
    }
  }
  covered.sort((a, b) => a[0] - b[0]);
  const out = [];
  let cursor = ws;
  for (const [s, en] of covered) {
    if (s > cursor && s - cursor >= 6e4) out.push([isoSeconds(cursor), isoSeconds(s)]);
    cursor = Math.max(cursor, en);
  }
  if (we > cursor && we - cursor >= 6e4) out.push([isoSeconds(cursor), isoSeconds(we)]);
  return out;
}
function uncoveredMillis(entries, start, end, nowIso2 = (/* @__PURE__ */ new Date()).toISOString()) {
  const ws = Date.parse(start);
  const we = Date.parse(end);
  const now = Date.parse(nowIso2);
  if (!Number.isFinite(ws) || !Number.isFinite(we) || we <= ws) return 0;
  const covered = [];
  if (Array.isArray(entries)) {
    for (const e of entries) {
      if (!isRecord(e)) continue;
      const s = typeof e.start_time === "string" ? Date.parse(e.start_time) : Number.NaN;
      const en = typeof e.end_time === "string" ? Date.parse(e.end_time) : e.end_time ? Number.NaN : Math.min(now, s + 864e5);
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
function metersFor(marks, start, end) {
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
  return { runtimeMin: Math.floor(runtime / 6e4), waitMin: Math.floor(wait / 6e4) };
}
var PROMPT_MARKS_MAX = 2e3;
function promptMarksFor(marks, start, end) {
  const ws = Date.parse(start);
  const we = Date.parse(end);
  const seconds = [...new Set(marks.filter((m) => m.k === "prompt" && m.t >= ws && m.t <= we).map((m) => Math.floor(m.t / 1e3) * 1e3))].sort((a, b) => a - b);
  if (seconds.length <= PROMPT_MARKS_MAX) return seconds.map((t) => isoSeconds(t));
  const out = [];
  const last = seconds.length - 1;
  for (let i = 0; i < PROMPT_MARKS_MAX; i += 1) {
    const idx = Math.round(i * last / (PROMPT_MARKS_MAX - 1));
    const t = seconds[idx];
    if (t !== void 0) out.push(isoSeconds(t));
  }
  return out;
}
function earliestFreeStart(message) {
  const m = /earliest free start is (\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/i.exec(String(message ?? ""));
  return m && m[1] !== void 0 ? m[1] : null;
}
function resolveFromMap(map, repoKey) {
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
function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}
function ensurePrivateDir(p) {
  mkdirSync(p, { recursive: true, mode: 448 });
  try {
    chmodSync(p, 448);
  } catch {
  }
  return p;
}
function modeOf(path) {
  try {
    return statSync(path).mode & 511;
  } catch {
    return void 0;
  }
}
function writeAtomic(path, text, mode) {
  const keep = mode ?? modeOf(path);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, keep === void 0 ? void 0 : { mode: keep });
  renameSync(tmp, path);
}
function writeUserFile(path, text, defaultMode = 384) {
  const mode = modeOf(path) ?? defaultMode;
  if (existsSync(path)) {
    try {
      const bak = existsSync(`${path}.bak`) ? `${path}.bak.${Date.now()}` : `${path}.bak`;
      writeFileSync(bak, readFileSync(path), { mode });
    } catch {
    }
  }
  writeAtomic(path, text, mode);
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
function refusalLogPath(env = process.env) {
  const fallback = join(shyreHome(), "refusals.log");
  const raw = env.SHYRE_HOOK_LOG;
  if (!raw) return fallback;
  const home = resolve(shyreHome());
  const target = resolve(raw);
  return target.startsWith(`${home}${sep}`) ? target : fallback;
}
function logRefusal(line) {
  try {
    const target = refusalLogPath();
    ensureDir(join(target, ".."));
    const flat = line.replace(/[\r\n]+/g, " ");
    appendFileSync(target, `${(/* @__PURE__ */ new Date()).toISOString()}	${flat}
`);
    try {
      chmodSync(target, 384);
    } catch {
    }
  } catch {
  }
}
function noteOncePerMinute(subject, line) {
  try {
    const marker = join(ensurePrivateDir(shyreHome()), `.said-${subject}`);
    const last = modeOf(marker) === void 0 ? 0 : statSync(marker).mtimeMs;
    if (Date.now() - last < 6e4) return;
    writeFileSync(marker, "", { mode: 384 });
    logRefusal(line);
  } catch {
  }
}
function payloadKeys(raw) {
  return isRecord(raw) ? Object.keys(raw).slice(0, 12).join(",") || "(none)" : typeof raw;
}
function gitRemote(cwd, env = process.env) {
  const clean = { ...env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete clean[k];
  for (const name of ["origin", "upstream"]) {
    try {
      const url = execFileSync("git", ["-c", "core.fsmonitor=", "-C", cwd, "remote", "get-url", name], {
        encoding: "utf8",
        timeout: 3e3,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        env: { ...clean, GIT_TERMINAL_PROMPT: "0" }
      }).trim();
      if (url) return url;
    } catch {
    }
  }
  return null;
}
function mapFileCandidates() {
  return [join(shyreHome(), "projects.json"), join(homedir(), ".claude", "shyre-projects.json")];
}
function readMapFile() {
  return readMapFileFrom()?.map ?? null;
}
function readMapFileFrom() {
  for (const candidate of mapFileCandidates()) {
    try {
      return { path: candidate, map: JSON.parse(readFileSync(candidate, "utf8")) };
    } catch {
    }
  }
  return null;
}
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
async function http(method, url, { apiKey, agent, session, body }) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" && url.startsWith("https:")) {
    return { status: 0, json: null, text: "refusing to send the token while NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate checks" };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1e4);
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
        "User-Agent": `shyre-hook/${VERSION}`
      },
      body: body === void 0 ? void 0 : JSON.stringify(body)
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
    return { status: 0, json: null, text: errorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}
function nowIso() {
  return isoSeconds(Date.now());
}
var STDIN_MAX_BYTES = 4 * 1024 * 1024;
function readStdin() {
  try {
    if (process.stdin.isTTY) return {};
    const text = readFileSync(0, "utf8");
    if (text.length > STDIN_MAX_BYTES) {
      noteOncePerMinute("stdin-size", `payload of ${text.length} bytes ignored: larger than ${STDIN_MAX_BYTES}`);
      return {};
    }
    return text.trim() ? JSON.parse(text) : {};
  } catch (err) {
    noteOncePerMinute("stdin-json", `payload was not JSON, nothing recorded: ${errorMessage(err).slice(0, 120)}`);
    return {};
  }
}
function detachedFlush() {
  if (process.env.SHYRE_NO_DETACH === "1") return;
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "flush"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.on("error", () => {
    });
    child.unref();
  } catch {
  }
}
function cmdStart(argvAgent, payload) {
  const agent = detectAgent(argvAgent, payload);
  const { session, cwd } = normalizePayload(payload);
  if (!session) {
    noteOncePerMinute("no-session", `${agent}	start payload names no session, nothing recorded; keys: ${payloadKeys(payload)}`);
    return;
  }
  const base = stateBase(agent, session);
  if (!existsSync(`${base}.meta.json`)) {
    const meta = {
      agent,
      label: AGENT_LABELS[agent],
      session,
      cwd,
      repoKey: repoKeyFromRemote(gitRemote(cwd))
    };
    writeAtomic(`${base}.meta.json`, JSON.stringify(meta), 384);
  }
  appendFileSync(`${base}.marks`, `${nowIso()} start
`, { mode: 384 });
  detachedFlush();
}
function cmdBeat(argvAgent, payload, tag) {
  const agent = detectAgent(argvAgent, payload);
  const { session } = normalizePayload(payload);
  if (!session) {
    noteOncePerMinute("no-session", `${agent}	beat payload names no session, nothing recorded; keys: ${payloadKeys(payload)}`);
    return;
  }
  const base = stateBase(agent, session);
  if (!existsSync(`${base}.meta.json`)) cmdStart(agent, payload);
  const k = tag === "tool" || tag === "stop" || tag === "prompt" ? tag : "tool";
  appendFileSync(`${base}.marks`, `${nowIso()} ${k}
`, { mode: 384 });
}
function coerceMeta(value, fallbackAgent, fallbackSession) {
  if (!isRecord(value)) return null;
  const agent = typeof value.agent === "string" && value.agent ? value.agent : fallbackAgent;
  const session = typeof value.session === "string" && value.session ? value.session : fallbackSession;
  return {
    agent,
    label: typeof value.label === "string" && value.label ? value.label : labelFor(agent),
    session,
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    repoKey: typeof value.repoKey === "string" ? value.repoKey : null
  };
}
function prometheusPort(env) {
  const raw = (env.OTEL_EXPORTER_PROMETHEUS_PORT ?? "").trim();
  if (raw === "") return 9464;
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}
var SCRAPE_MAX_BYTES = 1048576;
async function scrapeSessionTokens(session, fetchImpl = fetch) {
  const port = prometheusPort(process.env);
  if (port === null) return void 0;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 500);
  let text = "";
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/metrics`, { method: "GET", signal: ctl.signal, redirect: "manual" });
    if (res.status !== 200 || !res.body) return void 0;
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SCRAPE_MAX_BYTES) {
        ctl.abort();
        return void 0;
      }
      chunks.push(value);
    }
    text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  } catch {
    return void 0;
  } finally {
    clearTimeout(timer);
  }
  return parseSessionTokens(text, session);
}
function labelSetClose(line, open) {
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
function parseSessionTokens(text, session) {
  const byModel = /* @__PURE__ */ new Map();
  let cost = 0;
  let sawCost = false;
  const typeKey = { input: "input", output: "output", cacheRead: "cache_read", cacheCreation: "cache_creation" };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("claude_code_token_usage_total{") && !line.startsWith("claude_code_cost_usage_total{")) continue;
    const brace = line.indexOf("{");
    const close = labelSetClose(line, brace);
    if (brace < 0 || close < brace) continue;
    const labels = {};
    for (const m of line.slice(brace + 1, close).matchAll(/([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[m[1] ?? ""] = (m[2] ?? "").replace(/\\(["\\])/g, "$1");
    if (labels.session_id !== session) continue;
    const value = Number(line.slice(close + 1).trim().split(/\s+/)[0]);
    if (!Number.isFinite(value) || value < 0) continue;
    if (line.startsWith("claude_code_cost_usage_total{")) {
      cost += value;
      sawCost = true;
      continue;
    }
    const model2 = labels.model ?? "";
    const key = typeKey[labels.type ?? ""];
    if (!key || !model2 || key === "model" || key === "cost_usd_list") continue;
    const bucket = byModel.get(model2) ?? { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
    bucket[key] += Math.round(value);
    byModel.set(model2, bucket);
  }
  if (byModel.size === 0) return void 0;
  const [model, counts] = [...byModel.entries()].sort((a, b) => total(b[1]) - total(a[1]))[0] ?? [void 0, void 0];
  if (!model || !counts) return void 0;
  return { ...counts, model, cost_usd_list: sawCost ? Math.round(cost * 1e6) / 1e6 : 0 };
}
function total(c) {
  return c.input + c.output + c.cache_read + c.cache_creation;
}
async function cmdEnd(argvAgent, payload, { idleCapSeconds }, scrape = scrapeSessionTokens) {
  const agent = detectAgent(argvAgent, payload);
  const { session } = normalizePayload(payload);
  if (!session) {
    noteOncePerMinute("no-session", `${agent}	end payload names no session, nothing recorded; keys: ${payloadKeys(payload)}`);
    return;
  }
  const base = stateBase(agent, session);
  if (!existsSync(`${base}.meta.json`)) return;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(`${base}.meta.json`, "utf8"));
  } catch (err) {
    logRefusal(`${basename(base)}	unreadable session meta, marks left in place: ${errorMessage(err)}`);
    return;
  }
  const meta = coerceMeta(parsed, agent, session);
  if (!meta) {
    logRefusal(`${basename(base)}	session meta is not an object, marks left in place`);
    return;
  }
  if (meta.repoKey === null && meta.cwd) meta.repoKey = repoKeyFromRemote(gitRemote(meta.cwd));
  let marksText = "";
  try {
    marksText = readFileSync(`${base}.marks`, "utf8");
  } catch {
    marksText = "";
  }
  const runs = segmentRuns(parseMarks(marksText), idleCapSeconds);
  let last;
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
      marks: run.marks,
      // Keyed on the run's START INSTANT, not its ordinal: a session id is
      // reused across /clear and --resume, so "run 1" would recur, and the
      // server would answer the second with the FIRST entry as a replay —
      // a 2xx that deleted the spool file and lost the hours silently.
      idempotency_key: `${session}:${run.start}`,
      session_ref: session,
      created: nowIso()
    };
    const path = join(spoolDir(), `${agent}-${basename(base)}-${run.start.replace(/[^0-9TZ]/g, "")}.json`);
    writeAtomic(path, JSON.stringify(item), 384);
    last = { path, item };
  }
  if (last) {
    let tokens;
    try {
      tokens = await scrape(session);
    } catch {
      tokens = void 0;
    }
    if (tokens) writeAtomic(last.path, JSON.stringify({ ...last.item, agent_tokens: tokens }), 384);
  }
  try {
    unlinkSync(`${base}.marks`);
  } catch {
  }
  try {
    unlinkSync(`${base}.meta.json`);
  } catch {
  }
  if (runs.length > 0) detachedFlush();
}
function toProjectRows(value) {
  if (!Array.isArray(value)) return null;
  const rows = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    rows.push({ id: entry.id, github_repo: typeof entry.github_repo === "string" ? entry.github_repo : null });
  }
  return rows;
}
async function resolveProject(item, cfg, projectsCache) {
  const fromMap = resolveFromMap(readMapFile(), item.repo_key);
  if (fromMap) return { id: fromMap };
  if (!item.repo_key) return { id: null, reason: "unmapped" };
  if (!projectsCache.list && !projectsCache.failed) {
    const res = await http("GET", `${cfg.apiUrl}/api/v1/projects?status=all`, {
      apiKey: cfg.apiKey,
      agent: item.agent,
      session: item.session
    });
    if (res.status > 0) item.contacted = true;
    const rows = res.status === 200 ? toProjectRows(res.json) : null;
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
function isFinalRefusal(status) {
  return status >= 400 && status < 500 && ![401, 408, 429].includes(status);
}
var COVERAGE_MAX_PAGES = 10;
var COVERAGE_PAGE_SIZE = 100;
async function fetchCoverage(item, cfg, tag = "") {
  const since = new Date(Date.parse(item.start_time) - 86400 * 1e3).toISOString();
  const entries = [];
  let until = item.end_time;
  let previousOldest = Number.POSITIVE_INFINITY;
  for (let page = 0; page < COVERAGE_MAX_PAGES; page += 1) {
    const url = `${cfg.apiUrl}/api/v1/entries?limit=${COVERAGE_PAGE_SIZE}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`;
    let res = await http("GET", url, { apiKey: cfg.apiKey, agent: item.agent, session: item.session });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500));
      res = await http("GET", url, { apiKey: cfg.apiKey, agent: item.agent, session: item.session });
    }
    if (res.status > 0) item.contacted = true;
    if (res.status !== 200) return { complete: false, reason: `coverage check answered ${res.status || "no network"}` };
    if (!Array.isArray(res.json)) return { complete: false, reason: "coverage check answered 200 without an entries list" };
    entries.push(...res.json);
    if (res.json.length < COVERAGE_PAGE_SIZE) break;
    let oldest = Number.POSITIVE_INFINITY;
    for (const e of res.json) {
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
    await new Promise((r) => setTimeout(r, 1500));
    timer = await http("GET", `${cfg.apiUrl}/api/v1/timer`, { apiKey: cfg.apiKey, agent: item.agent, session: item.session });
  }
  if (timer.status === 401 || timer.status === 403) {
    logRefusal(`${tag}	timer check answered ${timer.status}; the running timer is not visible to this token`);
  } else if (timer.status !== 200) {
    return { complete: false, reason: `timer check answered ${timer.status || "no network"}` };
  } else if (isRecord(timer.json) && typeof timer.json.start_time === "string") {
    entries.push({ start_time: timer.json.start_time, end_time: null });
  }
  return { complete: true, entries };
}
async function deliver(item, cfg, projectsCache = {}) {
  if (!cfg.apiKey) return false;
  const tag = `${item.label}	${(item.repo_key || item.cwd).replace(/[\r\n\t]+/g, " ")}	${item.start_time}..${item.end_time}`;
  const ws = Date.parse(item.start_time);
  const we = Date.parse(item.end_time);
  if (!Number.isFinite(ws) || !Number.isFinite(we) || we <= ws) {
    logRefusal(`${tag}	invalid window (end not after start, or unparseable): discarded`);
    return true;
  }
  const resolved = await resolveProject(item, cfg, projectsCache);
  if (resolved.id === null) {
    if (resolved.reason === "lookup-failed") {
      const why = resolved.status === -2 ? "the server listed no projects at all" : `${resolved.status || "no network"}`;
      logRefusal(`${tag}	projects lookup failed (${why}), kept for retry`);
      return false;
    }
    logRefusal(`${tag}	unmapped: no map line and no project names this repo`);
    return true;
  }
  const projectId = resolved.id;
  const coverage = await fetchCoverage(item, cfg, tag);
  let segments = [[isoSeconds(ws), isoSeconds(we)]];
  if (coverage.complete) {
    segments = uncoveredSegments(coverage.entries, item.start_time, item.end_time);
    if (segments.length === 0) {
      const dropped = Math.round(uncoveredMillis(coverage.entries, item.start_time, item.end_time) / 1e3);
      logRefusal(dropped > 0 ? `${tag}	covered: stood down; ${dropped} s uncovered under the one-minute floor, dropped` : `${tag}	covered: stood down, this window was already logged`);
      return true;
    }
    if (!isWhole(segments, ws, we)) {
      const posted = segments.reduce((n, [a, b]) => n + (Date.parse(b) - Date.parse(a)), 0);
      logRefusal(`${tag}	covered in part: stood down ${Math.round((we - ws - posted) / 6e4)} min already logged; posting ${segments.length} uncovered segment(s)`);
    }
  } else {
    if (item.backfilled) {
      logRefusal(`${tag}	${coverage.reason}; a backfilled run is kept for retry, never posted blind`);
      return false;
    }
    logRefusal(`${tag}	${coverage.reason}; posting without it`);
  }
  const done = new Set(item.done ?? []);
  if (!coverage.complete && done.size > 0) {
    logRefusal(`${tag}	part of this run already landed and coverage is unknown; kept for a sweep that can ask`);
    return false;
  }
  let settled = true;
  for (const [segStart, segEnd] of segments) {
    if (done.has(`${segStart}|${segEnd}`)) {
      continue;
    }
    const outcome = await postSegment(item, cfg, projectId, tag, segStart, segEnd, ws, we);
    if (outcome === "kept") settled = false;
    else done.add(`${segStart}|${segEnd}`);
  }
  item.done = [...done].sort();
  return settled;
}
function isWhole(segments, ws, we) {
  const only = segments.length === 1 ? segments[0] : void 0;
  return only !== void 0 && Date.parse(only[0]) === ws && Date.parse(only[1]) === we;
}
async function postSegment(item, cfg, projectId, tag, segStart, segEnd, ws, we) {
  let start = segStart;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const whole = Date.parse(start) === ws && Date.parse(segEnd) === we;
    const meters = whole ? { runtimeMin: item.agent_runtime_min, waitMin: item.agent_wait_min } : item.marks ? metersFor(item.marks, start, segEnd) : void 0;
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
      prompt_marks: item.marks ? promptMarksFor(item.marks, start, segEnd) : void 0,
      backfilled: item.backfilled === true,
      // A split run's tokens cannot be apportioned to one of its segments;
      // only the whole run carries them.
      agent_tokens: whole ? item.agent_tokens : void 0
    });
    const res = await http("POST", `${cfg.apiUrl}/api/v1/entries`, {
      apiKey: cfg.apiKey,
      agent: item.agent,
      session: item.session,
      body
    });
    if (res.status > 0) item.contacted = true;
    if (res.status >= 200 && res.status < 300) {
      if (!isRecord(res.json)) {
        logRefusal(`${tag}	${res.status} without an entry body, kept for retry`);
        return "kept";
      }
      const gotStart = typeof res.json.start_time === "string" ? Date.parse(res.json.start_time) : Number.NaN;
      const gotEnd = typeof res.json.end_time === "string" ? Date.parse(res.json.end_time) : Number.NaN;
      if (Number.isFinite(gotStart) && Number.isFinite(gotEnd) && (Math.abs(gotStart - Date.parse(start)) > 1e3 || Math.abs(gotEnd - Date.parse(segEnd)) > 1e3)) {
        logRefusal(`${tag}	${res.status} replayed an existing entry with a different window (${res.json.start_time}..${res.json.end_time}); ${start}..${segEnd} kept for retry`);
        return "kept";
      }
      return "posted";
    }
    if (res.status === 409 && attempt === 0) {
      const free = earliestFreeStart(isRecord(res.json) ? res.json.message : void 0);
      if (free && Date.parse(free) > Date.parse(start) && Date.parse(segEnd) - Date.parse(free) >= 6e4) {
        start = free;
        continue;
      }
    }
    if (isFinalRefusal(res.status)) {
      if (res.status === 400 && (item.tries ?? 0) < 1) {
        logRefusal(`${tag}	400 on the first attempt, kept for one retry	${res.text.replace(/\s+/g, " ").slice(0, 400)}`);
        return "kept";
      }
      logRefusal(`${tag}	${res.status}	${res.text.replace(/\s+/g, " ").slice(0, 400)}`);
      return "final";
    }
    logRefusal(`${tag}	${res.status || "no network"}	kept for retry${res.status ? "" : `	${res.text.replace(/\s+/g, " ").slice(0, 200)}`}`);
    return "kept";
  }
  return "kept";
}
function coerceSpoolItem(value) {
  if (!isRecord(value)) return null;
  const session = typeof value.session === "string" ? value.session : typeof value.session_ref === "string" ? value.session_ref : null;
  const start = typeof value.start_time === "string" ? value.start_time : null;
  const end = typeof value.end_time === "string" ? value.end_time : null;
  if (!session || !start || !end) return null;
  const agent = typeof value.agent === "string" && value.agent ? value.agent : "claude";
  const minutes = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : void 0;
  const marks = Array.isArray(value.marks) ? value.marks.flatMap((m) => isRecord(m) && typeof m.t === "number" && Number.isFinite(m.t) ? [{ t: m.t, k: typeof m.k === "string" ? m.k : "tool" }] : []) : void 0;
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
    ...marks ? { marks } : {},
    ...Array.isArray(value.done) ? { done: value.done.filter((d) => typeof d === "string") } : {},
    ...typeof value.created === "string" ? { created: value.created } : {},
    ...typeof value.tries === "number" && Number.isFinite(value.tries) && value.tries >= 0 ? { tries: value.tries } : {},
    ...typeof value.drop_attempts === "number" && Number.isFinite(value.drop_attempts) && value.drop_attempts >= 0 ? { drop_attempts: value.drop_attempts } : {},
    ...value.backfilled === true ? { backfilled: true } : {}
  };
}
var MAX_TRIES = 20;
var PRUNE_AFTER_DAYS = 30;
var DROP_REPORT_PATH = "/api/v1/entries/dropped";
var DROP_GIVE_UP_DAYS = 90;
var DROP_GIVE_UP_ATTEMPTS = 3;
var REPO_KEY_SHAPE = /^(?!\.{1,2}\/)[a-z0-9._-]+\/[a-z0-9._-]+$/;
async function reportDrop(item, cfg, reason, keptDays) {
  if (!cfg.apiKey) return { reported: false, contacted: false, why: "no credential" };
  const res = await http("POST", `${cfg.apiUrl}${DROP_REPORT_PATH}`, {
    apiKey: cfg.apiKey,
    agent: item.agent,
    session: item.session,
    body: {
      agent_label: item.label.slice(0, 64),
      repo_key: item.repo_key && REPO_KEY_SHAPE.test(item.repo_key) ? item.repo_key : void 0,
      start_time: item.start_time,
      end_time: item.end_time,
      session_ref: item.session_ref.slice(0, 128),
      idempotency_key: item.idempotency_key.slice(0, 128),
      tries: item.tries ?? 0,
      kept_days: Math.max(0, keptDays),
      reason
    }
  });
  if (res.status >= 200 && res.status < 300) {
    if (isRecord(res.json) && res.json.recorded === true) return { reported: true, contacted: true, why: "" };
    return { reported: false, contacted: true, why: `${res.status} without a record` };
  }
  return { reported: false, contacted: res.status > 0, why: res.status ? String(res.status) : `no network: ${res.text.replace(/\s+/g, " ").slice(0, 120)}` };
}
async function cmdFlush(cfg) {
  const dir = spoolDir();
  const cache = {};
  const dayAgo = Date.now() - 86400 * 1e3;
  const weekAgo = Date.now() - 7 * 86400 * 1e3;
  const pruneBefore = Date.now() - PRUNE_AFTER_DAYS * 86400 * 1e3;
  const giveUpBefore = Date.now() - DROP_GIVE_UP_DAYS * 86400 * 1e3;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name.endsWith(".tmp")) {
      try {
        if (statSync(path).mtimeMs < dayAgo) unlinkSync(path);
      } catch {
      }
      continue;
    }
    if (!name.endsWith(".json")) continue;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      let text;
      try {
        text = readFileSync(path, "utf8");
      } catch (err) {
        logRefusal(`${name}	could not be read, kept for retry: ${errorMessage(err)}`);
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        logRefusal(`${name}	unreadable: ${errorMessage(err)}`);
        unlinkSync(path);
        continue;
      }
      const item = coerceSpoolItem(parsed);
      if (!item) {
        if (stat.mtimeMs < pruneBefore) {
          logRefusal(`${name}	pruned: shape not recognized by any sweep for ${PRUNE_AFTER_DAYS} days`);
          unlinkSync(path);
        } else {
          logRefusal(`${name}	shape not recognized by runtime ${VERSION}, kept`);
        }
        continue;
      }
      const createdMs = item.created ? Date.parse(item.created) : Number.NaN;
      const age = Number.isFinite(createdMs) ? createdMs : stat.mtimeMs;
      const windowElapsed = age < pruneBefore && (item.tries ?? 0) >= 1;
      if (windowElapsed || !item.created && (item.tries ?? 0) >= MAX_TRIES) {
        const why = `kept for retry ${item.tries} time(s)${windowElapsed ? ` over ${PRUNE_AFTER_DAYS} days` : ""}`;
        if (isRecord(parsed) && parsed.drop_reported === true) {
          logRefusal(`${name}	pruned: ${why}; reported to the server on an earlier sweep`);
          unlinkSync(path);
          continue;
        }
        const report = await reportDrop(item, cfg, windowElapsed ? "retry_window_elapsed" : "retry_cap_reached", Math.round((Date.now() - age) / (86400 * 1e3)));
        if (report.reported) {
          logRefusal(`${name}	pruned: ${why}; reported to the server`);
          try {
            unlinkSync(path);
          } catch (err) {
            if (err.code !== "ENOENT") {
              try {
                writeAtomic(path, JSON.stringify({ ...isRecord(parsed) ? parsed : {}, drop_reported: true }), 384);
              } catch (err2) {
                logRefusal(`${name}	could not delete or mark the reported item: ${errorMessage(err2)}`);
              }
            }
          }
          continue;
        }
        if (report.contacted) {
          item.drop_attempts = (item.drop_attempts ?? 0) + 1;
          try {
            writeAtomic(path, JSON.stringify({ ...isRecord(parsed) ? parsed : {}, drop_attempts: item.drop_attempts }), 384);
          } catch (err) {
            logRefusal(`${name}	could not record the drop attempt: ${errorMessage(err)}`);
          }
        }
        const attempts = item.drop_attempts ?? 0;
        if (attempts >= DROP_GIVE_UP_ATTEMPTS && (age < giveUpBefore || !item.created)) {
          logRefusal(`${name}	pruned: ${why}; the server could not be told in ${attempts} answered attempt(s) over ${DROP_GIVE_UP_DAYS} days (last answer: ${report.why})`);
          unlinkSync(path);
          continue;
        }
        logRefusal(`${name}	to be dropped (${why}); the server could not be told (${report.why}), kept until it can`);
        continue;
      }
      const before = JSON.stringify({ done: item.done ?? [], tries: item.tries ?? 0 });
      if (await deliver(item, cfg, cache)) {
        try {
          unlinkSync(path);
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
          logRefusal(`${name}	removed by a concurrent sweep`);
        }
      } else {
        if (item.contacted) item.tries = (item.tries ?? 0) + 1;
        if (JSON.stringify({ done: item.done ?? [], tries: item.tries ?? 0 }) !== before) {
          try {
            if (existsSync(path)) writeAtomic(path, JSON.stringify({ ...JSON.parse(text), done: item.done, tries: item.tries }), 384);
          } catch (err) {
            logRefusal(`${name}	could not record the sweep's result: ${errorMessage(err)}`);
          }
        }
      }
    } catch (err) {
      if (err.code === "ENOENT") {
        logRefusal(`${name}	removed by a concurrent sweep`);
        continue;
      }
      logRefusal(`${name}	delivery threw, kept for retry: ${errorMessage(err)}`);
    }
  }
  const sessions = sessionsDir();
  for (const name of readdirSync(sessions)) {
    const path = join(sessions, name);
    try {
      if (statSync(path).mtimeMs < weekAgo) {
        if (name.endsWith(".meta.json")) logRefusal(`${name}	pruned: session never ended, marks discarded`);
        unlinkSync(path);
      }
    } catch {
    }
  }
}
function nodeCommand(scriptPath, agent, args) {
  if (!/^[A-Za-z0-9_./\\: -]+$/.test(scriptPath)) {
    throw new Error(`refusing to write a hook command for a path with shell-significant characters: ${scriptPath}`);
  }
  return `node "${scriptPath}" ${agent} ${args}`;
}
function selfPath() {
  return fileURLToPath(import.meta.url);
}
function installRuntimeCopy() {
  const bin = ensurePrivateDir(join(shyreHome(), "bin"));
  const target = join(bin, "shyre-hook.mjs");
  const self = selfPath();
  if (self !== target) writeAtomic(target, readFileSync(self, "utf8"));
  return target;
}
function readUserJson(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} exists but is not valid JSON (${errorMessage(err)}); fix or move it, then run install again \u2014 nothing was changed`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${path} exists but is not a JSON object; fix or move it, then run install again \u2014 nothing was changed`);
  }
  return parsed;
}
function claudeShapedHooks(agent, scriptPath, timeouts = {}) {
  const hooks = {};
  for (const [event, args] of HOOK_WIRING[agent]) {
    const hook = { type: "command", command: nodeCommand(scriptPath, agent, args) };
    const timeout = timeouts[event];
    if (timeout !== void 0 && timeout > 0) hook.timeout = timeout;
    hooks[event] = [event === "PostToolUse" ? { matcher: ".*", hooks: [hook] } : { hooks: [hook] }];
  }
  return { hooks };
}
function cursorHooks(scriptPath) {
  const hooks = {};
  for (const [event, args] of HOOK_WIRING.cursor) {
    hooks[event] = [{ command: nodeCommand(scriptPath, "cursor", args) }];
  }
  return { version: 1, hooks };
}
var OURS = /\bnode\s+(?:"[^"]*shyre-hook\.mjs"|\S*shyre-hook\.mjs)\s+(?:claude|codex|cursor|gemini|copilot|opencode)\s+(?:start|beat|end)\b/;
function isOurEntry(entry) {
  const commands = [];
  if (isRecord(entry)) {
    if (typeof entry.command === "string") commands.push(entry.command);
    if (Array.isArray(entry.hooks)) {
      for (const h of entry.hooks) if (isRecord(h) && typeof h.command === "string") commands.push(h.command);
    }
  }
  return commands.some((c) => OURS.test(c));
}
function mergeHooks(existing, ours) {
  const out = { ...existing };
  const prevHooks = isRecord(out.hooks) ? { ...out.hooks } : {};
  const hooks = prevHooks;
  for (const [event, entries] of Object.entries(ours.hooks)) {
    const prev = hooks[event];
    const kept = Array.isArray(prev) ? prev.filter((e) => !isOurEntry(e)) : [];
    hooks[event] = [...kept, ...entries];
  }
  out.hooks = hooks;
  if (ours.version !== void 0) out.version = ours.version;
  return out;
}
var CONVENTION = `## Shyre \u2014 log your own time

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
function upsertBlock(path, block, marker) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.includes(marker)) return false;
  writeUserFile(path, `${existing.trimEnd()}${existing ? "\n\n" : ""}${block}`);
  return true;
}
function installOrigin(argv) {
  const flag = argv.find((a) => a.startsWith("--api-url="));
  if (!flag) return DEFAULT_API_URL;
  const url = validApiUrl(flag.slice("--api-url=".length));
  if (!url) throw new Error(`--api-url must be an https origin with no path (got ${JSON.stringify(flag.slice("--api-url=".length))})`);
  return url;
}
function installCodex(home = homedir(), scriptPath, apiUrl = DEFAULT_API_URL) {
  const dir = ensureDir(join(home, ".codex"));
  const hooksPath = join(dir, "hooks.json");
  const merged = mergeHooks(readUserJson(hooksPath), claudeShapedHooks("codex", scriptPath, { SessionEnd: 3 }));
  writeUserFile(hooksPath, `${JSON.stringify(merged, null, 2)}
`);
  const tomlPath = join(dir, "config.toml");
  const toml = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
  const changed = [hooksPath];
  if (!/^\[mcp_servers\.shyre\]/m.test(toml)) {
    const block = `
[mcp_servers.shyre]
url = "${apiUrl}/api/mcp"
bearer_token_env_var = "SHYRE_API_KEY"
`;
    writeUserFile(tomlPath, `${toml.trimEnd()}
${block}`);
    changed.push(tomlPath);
  }
  if (upsertBlock(join(dir, "AGENTS.md"), CONVENTION, "## Shyre \u2014 log your own time")) changed.push(join(dir, "AGENTS.md"));
  return changed;
}
var POST_INSTALL_NOTES = Object.freeze({
  codex: [
    "Open Codex and run /hooks to review and TRUST the shyre hooks \u2014 Codex skips untrusted hooks silently, and re-trusting is needed after any change to them.",
    "Codex hooks inherit your shell environment, so SHYRE_API_KEY exported there is enough; ~/.shyre/config.json is the fallback for shells that do not export it."
  ],
  cursor: [
    "If the Claude Code plugin is installed too, Cursor loads it as well; the runtime detects the Cursor session from its payload and records it once, as Cursor.",
    "On Windows, Cursor delivers the hook payload through a POSIX heredoc, which cmd and PowerShell cannot parse; use WSL or Git Bash for cursor-agent there."
  ]
});
function postInstallNotes(agent) {
  if (agent === "codex" || agent === "cursor") return POST_INSTALL_NOTES[agent];
  return [];
}
function installCursor(home = homedir(), scriptPath, apiUrl = DEFAULT_API_URL) {
  const dir = ensureDir(join(home, ".cursor"));
  const hooksPath = join(dir, "hooks.json");
  const mcpPath = join(dir, "mcp.json");
  const existingHooks = readUserJson(hooksPath);
  const mcp = readUserJson(mcpPath);
  const merged = mergeHooks(existingHooks, cursorHooks(scriptPath));
  writeUserFile(hooksPath, `${JSON.stringify(merged, null, 2)}
`);
  const servers = isRecord(mcp.mcpServers) ? mcp.mcpServers : {};
  mcp.mcpServers = servers;
  const changed = [hooksPath];
  if (!servers.shyre) {
    servers.shyre = {
      url: `${apiUrl}/api/mcp`,
      headers: { Authorization: "Bearer ${SHYRE_API_KEY}" }
    };
    writeUserFile(mcpPath, `${JSON.stringify(mcp, null, 2)}
`);
    changed.push(mcpPath);
  }
  const rules = ensureDir(join(dir, "rules"));
  const rulePath = join(rules, "shyre.mdc");
  if (!existsSync(rulePath)) {
    writeAtomic(rulePath, `---
description: Log your own time to Shyre
alwaysApply: true
---

${CONVENTION}`, 420);
    changed.push(rulePath);
  }
  return changed;
}
function withoutOurHooks(existing) {
  const out = { ...existing };
  const prevHooks = isRecord(out.hooks) ? { ...out.hooks } : {};
  let changed = false;
  for (const [event, entries] of Object.entries(prevHooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((e) => !isOurEntry(e));
    if (kept.length !== entries.length) changed = true;
    if (kept.length === 0) delete prevHooks[event];
    else prevHooks[event] = kept;
  }
  out.hooks = prevHooks;
  return { file: out, changed };
}
function withoutBlock(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const rest = text.slice(at + marker.length);
  const next = rest.search(/\n## /);
  const after = next < 0 ? "" : rest.slice(next + 1);
  return `${text.slice(0, at).trimEnd()}${after ? `

${after}` : "\n"}`;
}
function uninstallCodex(home = homedir()) {
  const dir = join(home, ".codex");
  const changed = [];
  const hooksPath = join(dir, "hooks.json");
  if (existsSync(hooksPath)) {
    const { file, changed: did } = withoutOurHooks(readUserJson(hooksPath));
    if (did) {
      writeUserFile(hooksPath, `${JSON.stringify(file, null, 2)}
`);
      changed.push(hooksPath);
    }
  }
  const tomlPath = join(dir, "config.toml");
  if (existsSync(tomlPath)) {
    const toml = readFileSync(tomlPath, "utf8");
    const stripped = toml.replace(/\n?\[mcp_servers\.shyre\][^[]*/m, "\n");
    if (stripped !== toml) {
      writeUserFile(tomlPath, `${stripped.trimEnd()}
`);
      changed.push(tomlPath);
    }
  }
  const agentsPath = join(dir, "AGENTS.md");
  if (existsSync(agentsPath)) {
    const without = withoutBlock(readFileSync(agentsPath, "utf8"), "## Shyre \u2014 log your own time");
    if (without !== null) {
      writeUserFile(agentsPath, without, 420);
      changed.push(agentsPath);
    }
  }
  return changed;
}
function uninstallCursor(home = homedir()) {
  const dir = join(home, ".cursor");
  const changed = [];
  const hooksPath = join(dir, "hooks.json");
  if (existsSync(hooksPath)) {
    const { file, changed: did } = withoutOurHooks(readUserJson(hooksPath));
    if (did) {
      writeUserFile(hooksPath, `${JSON.stringify(file, null, 2)}
`);
      changed.push(hooksPath);
    }
  }
  const mcpPath = join(dir, "mcp.json");
  if (existsSync(mcpPath)) {
    const mcp = readUserJson(mcpPath);
    const servers = isRecord(mcp.mcpServers) ? { ...mcp.mcpServers } : null;
    if (servers && servers.shyre !== void 0) {
      delete servers.shyre;
      mcp.mcpServers = servers;
      writeUserFile(mcpPath, `${JSON.stringify(mcp, null, 2)}
`);
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
function cmdInstall(agent, opts = { apiUrl: DEFAULT_API_URL, uninstall: false }) {
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
function tokensDoctorLine(env) {
  const exporter = (env.OTEL_METRICS_EXPORTER ?? "").trim();
  const prometheus = exporter.split(",").map((e) => e.trim().toLowerCase()).includes("prometheus");
  const telemetry = (env.CLAUDE_CODE_ENABLE_TELEMETRY ?? "").trim() === "1";
  const port = prometheusPort(env);
  if (telemetry && prometheus && port === null) {
    return `tokens: OTEL_EXPORTER_PROMETHEUS_PORT=${env.OTEL_EXPORTER_PROMETHEUS_PORT ?? ""} is not a port \u2014 the third meter is not read until it is one (1\u201365535)`;
  }
  if (telemetry && prometheus) {
    return `tokens: exporter on (127.0.0.1:${port}) \u2014 the third meter is read once, at session end, for this session's id only; one session per machine binds the port, the rest report nothing`;
  }
  if (exporter && !prometheus) {
    return `tokens: OTEL_METRICS_EXPORTER=${exporter} is another exporter \u2014 left alone; the third meter is not read`;
  }
  return "tokens: off \u2014 to record the third meter, export CLAUDE_CODE_ENABLE_TELEMETRY=1 and OTEL_METRICS_EXPORTER=prometheus before starting the agent (nothing leaves the machine but four counts, a model name and one list-price figure)";
}
async function doctorLines(cfg, cwd = process.cwd(), probe = cfg.apiUrl === DEFAULT_API_URL) {
  const lines = [`shyre-hook ${VERSION}`, `home: ${shyreHome()}`];
  const attempt = (label, fn) => {
    try {
      lines.push(fn());
    } catch (err) {
      lines.push(`${label}: could not be read (${errorMessage(err)})`);
    }
  };
  attempt("api", () => `api: ${cfg.apiUrl}${cfg.apiUrl === DEFAULT_API_URL ? "" : `   WARNING: not the default ${DEFAULT_API_URL} \u2014 set by SHYRE_API_URL or ~/.shyre/config.json; the token is sent here`}`);
  attempt("token", () => `token: ${cfg.apiKey ? `present (${cfg.apiKey.slice(0, 14)}\u2026)` : "MISSING \u2014 export SHYRE_API_KEY or write ~/.shyre/config.json"}`);
  attempt("config file", () => {
    const configPath = join(shyreHome(), "config.json");
    const mode = modeOf(configPath);
    if (mode === void 0) return "config file: none";
    return `config file: ${mode & 63 ? `present \u2014 WARNING: mode ${mode.toString(8)} is readable by others; chmod 600 it` : "present, mode 600"}`;
  });
  attempt("idle cap", () => `idle cap: ${cfg.idleCapSeconds}s`);
  attempt("tls", () => process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ? "tls: WARNING: NODE_TLS_REJECT_UNAUTHORIZED=0 \u2014 the hook refuses to send the token while certificate checks are off" : "tls: certificate checks on");
  attempt("tokens", () => tokensDoctorLine(process.env));
  const remote = gitRemote(cwd);
  const repoKey = repoKeyFromRemote(remote);
  const mapFile = readMapFileFrom();
  attempt("repo", () => `repo: ${cwd} \u2192 ${remote ?? "no git remote"} \u2192 ${repoKey ?? "no repo key"}`);
  attempt("map", () => {
    if (!mapFile) return "map: none (server github_repo fallback only)";
    const hit = repoKey ? resolveFromMap(mapFile.map, repoKey) : null;
    const dflt = isRecord(mapFile.map) && typeof mapFile.map._default === "string" ? ` (a _default routes unmapped repos to ${mapFile.map._default})` : "";
    return `map: ${mapFile.path}${dflt} \u2192 ${hit ? `this repo \u2192 ${hit}` : "this repo is not in it"}`;
  });
  if (cfg.apiKey && !probe) {
    lines.push(`server: not asked \u2014 the origin is not the default; run doctor --probe to send the token to ${cfg.apiUrl}`);
  } else if (cfg.apiKey) {
    try {
      const res = await http("GET", `${cfg.apiUrl}/api/v1/projects?status=all`, { apiKey: cfg.apiKey, agent: "claude", session: "doctor" });
      const rows = res.status === 200 ? toProjectRows(res.json) : null;
      if (rows) {
        const hit = repoKey ? rows.find((p) => p.github_repo !== null && p.github_repo.toLowerCase() === repoKey) : void 0;
        lines.push(`server: ${res.status}, ${rows.length} project(s)${repoKey ? `; ${hit ? `github_repo names this repo \u2192 ${hit.id}` : "NO project's github_repo names this repo \u2014 sessions here will be kept, then pruned"}` : ""}`);
      } else {
        lines.push(`server: ${res.status === 401 ? "401 \u2014 the token is refused (revoked, expired, offboarded, or the team's integrations are off); re-mint it" : `${res.status || "no network"} \u2014 ${res.text.replace(/\s+/g, " ").slice(0, 120)}`}`);
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
    return `spool: ${spoolItems.length} pending${spoolItems.length ? ` (oldest ${Math.round((Date.now() - oldest) / 36e5)} h; pruned after 7 days once tried)` : ""}`;
  });
  attempt("sessions", () => {
    const dir = sessionsDir();
    const names = readdirSync(dir);
    const open = names.filter((n) => n.endsWith(".meta.json")).length;
    const newest = names.filter((n) => n.endsWith(".marks")).reduce((acc, n) => Math.max(acc, statSync(join(dir, n)).mtimeMs), 0);
    return `sessions: ${open} open; last mark recorded: ${newest ? new Date(newest).toISOString() : "never (no session has written a mark; if an agent is running, its hook is not firing or its payload is not read \u2014 see refusals)"}`;
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
async function cmdDoctor(argv = []) {
  const cfg = readConfig();
  const lines = await doctorLines(cfg, process.cwd(), cfg.apiUrl === DEFAULT_API_URL || argv.includes("--probe"));
  process.stdout.write(`${lines.join("\n")}
`);
}
var TRANSCRIPT_FIELDS = ["type", "timestamp", "cwd", "sessionId", "isMeta", "toolUseResult"];
function pickTranscriptEvent(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const type = typeof parsed[TRANSCRIPT_FIELDS[0]] === "string" ? parsed[TRANSCRIPT_FIELDS[0]] : "";
  if (type !== "user" && type !== "assistant") return null;
  if (parsed[TRANSCRIPT_FIELDS[4]] === true) return null;
  const ts = typeof parsed[TRANSCRIPT_FIELDS[1]] === "string" ? Date.parse(parsed[TRANSCRIPT_FIELDS[1]]) : Number.NaN;
  if (!Number.isFinite(ts)) return null;
  const cwd = typeof parsed[TRANSCRIPT_FIELDS[2]] === "string" ? parsed[TRANSCRIPT_FIELDS[2]] : null;
  const sid = typeof parsed[TRANSCRIPT_FIELDS[3]] === "string" ? parsed[TRANSCRIPT_FIELDS[3]] : null;
  const toolResult = parsed[TRANSCRIPT_FIELDS[5]] !== void 0;
  return { type, t: ts, cwd, sessionId: sid, toolResult };
}
function marksFromTranscriptEvents(events) {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const marks = sorted.map((e) => ({ t: e.t, k: e.type === "user" && !e.toolResult ? "prompt" : "tool" }));
  for (let i = 1; i < marks.length; i++) {
    const cur = marks[i];
    const prev = marks[i - 1];
    if (cur && prev && cur.k === "prompt" && prev.k === "tool") prev.k = "stop";
  }
  return marks;
}
function optionValue(argv, name) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
function backfillOptions(argv, env = process.env, now = Date.now()) {
  const since = optionValue(argv, "since");
  const until = optionValue(argv, "until");
  const sinceMs = since ? Date.parse(since) : now - 30 * 86400 * 1e3;
  const untilMs = until ? Date.parse(until) : now;
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs >= untilMs) {
    throw new Error("backfill: --since and --until must be dates (YYYY-MM-DD), since before until");
  }
  const explicit = optionValue(argv, "transcripts");
  const configDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR : join(homedir(), ".claude");
  return { sinceMs, untilMs, dryRun: argv.includes("--dry-run"), transcriptsDir: explicit ?? join(configDir, "projects") };
}
function readTranscriptSessions(dir, sinceMs, untilMs) {
  const sessions = /* @__PURE__ */ new Map();
  let projects = [];
  try {
    projects = readdirSync(dir).sort();
  } catch {
    return [];
  }
  for (const project of projects) {
    const projectDir = join(dir, project);
    let files = [];
    try {
      files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl")).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const path = join(projectDir, file);
      try {
        if (statSync(path).mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
      let text;
      try {
        text = readFileSync(path, "utf8");
      } catch (err) {
        logRefusal(`backfill	${path}	could not be read, skipped: ${errorMessage(err)}`);
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
function hooksSessionMoving(sessionId, nowMs, idleCapMs) {
  try {
    const marks = `${stateBase("claude", sessionId)}.marks`;
    if (!existsSync(marks)) return false;
    return nowMs - statSync(marks).mtimeMs < idleCapMs;
  } catch {
    return false;
  }
}
function planBackfill(sessions, idleCapSeconds, createdIso = nowIso(), nowMs = Date.now(), liveSession = hooksSessionMoving) {
  const runs = [];
  const skipped = [];
  const idleCapMs = idleCapSeconds * 1e3;
  let unmapped = 0;
  for (const session of sessions) {
    if (session.events.length === 0) continue;
    const newest = session.events.reduce((m, e) => e.t > m ? e.t : m, 0);
    if (nowMs - newest < idleCapMs || liveSession(session.sessionId, nowMs, idleCapMs)) {
      skipped.push(session.sessionId);
      continue;
    }
    const marks = marksFromTranscriptEvents(session.events);
    const cwd = session.cwd ?? "";
    let repoKey = null;
    if (cwd) {
      try {
        repoKey = existsSync(cwd) ? repoKeyFromRemote(gitRemote(cwd)) : null;
      } catch {
        repoKey = null;
      }
    }
    const segmented = segmentRuns(marks, idleCapSeconds);
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
        backfilled: true
      });
    }
  }
  return { sessions: sessions.length, runs, unmapped, skipped };
}
function formatBackfillPlan(plan, opts) {
  const minutes = plan.runs.reduce((sum, r) => sum + Math.round((Date.parse(r.end_time) - Date.parse(r.start_time)) / 6e4), 0);
  const lines = [
    `backfill: ${new Date(opts.sinceMs).toISOString().slice(0, 10)} \u2192 ${new Date(opts.untilMs).toISOString().slice(0, 10)}${opts.dryRun ? " (dry run \u2014 nothing written)" : ""}`,
    `  sessions with activity: ${plan.sessions}`,
    `  runs found: ${plan.runs.length} (${minutes} min of active time, idle gaps excluded)`,
    `  runs on a directory no project names: ${plan.unmapped} session(s) \u2014 they will be refused as unmapped and written to the refusals log`,
    `  skipped as still moving: ${plan.skipped.length} session(s) \u2014 inside the idle cap, or the hooks are writing marks for them; run backfill again after they end`
  ];
  for (const r of plan.runs.slice(0, 200)) {
    const shown = r.repo_key && REPO_KEY_SHAPE.test(r.repo_key) ? r.repo_key : r.repo_key ? "(local)" : "(unmapped)";
    lines.push(`  ${r.start_time}  ${r.end_time}  ${String(r.agent_runtime_min ?? 0).padStart(4)}m working ${String(r.agent_wait_min ?? 0).padStart(4)}m waiting  ${shown}`);
  }
  if (plan.runs.length > 200) lines.push(`  \u2026 and ${plan.runs.length - 200} more`);
  return lines.join("\n");
}
async function cmdBackfill(argv, cfg) {
  const opts = backfillOptions(argv);
  const sessions = readTranscriptSessions(opts.transcriptsDir, opts.sinceMs, opts.untilMs);
  const plan = planBackfill(sessions, cfg.idleCapSeconds);
  process.stdout.write(`${formatBackfillPlan(plan, opts)}
`);
  if (opts.dryRun) return;
  for (const id of plan.skipped) logRefusal(`backfill	${id}	skipped: still moving inside the idle cap; run backfill again after it ends`);
  if (plan.runs.length === 0) return;
  const dir = spoolDir();
  let spooled = 0;
  for (const item of plan.runs) {
    const safe = String(item.session).replace(/[^A-Za-z0-9._-]/g, "_");
    try {
      writeAtomic(join(dir, `claude-backfill-${safe}-${item.start_time.replace(/[^0-9TZ]/g, "")}.json`), JSON.stringify(item), 384);
      spooled += 1;
    } catch (err) {
      logRefusal(`backfill	${item.session}	${item.start_time}	could not be spooled: ${errorMessage(err)}`);
    }
  }
  process.stdout.write(`  spooled ${spooled} run(s); delivering now \u2014 a window an entry already covers is skipped, and anything refused is in the refusals log.
`);
  await cmdFlush(cfg);
}
var INTERACTIVE = /* @__PURE__ */ new Set(["install", "doctor", "backfill"]);
async function main(argv) {
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
      `shyre: ${uninstall ? "removed from" : "configured"} ${second ?? ""}${uninstall ? "" : ` \u2014 API origin ${apiUrl}`}
${changed.length ? changed.map((p) => `  ${p}`).join("\n") : "  (nothing to change)"}
` + (notes.length ? `
Next:
${notes.map((n) => `  - ${n}`).join("\n")}
` : "")
    );
    return;
  }
  if (first === void 0 || !isAgent(first)) return;
  const payload = readStdin();
  if (second === "start") return cmdStart(first, payload);
  if (second === "beat") return cmdBeat(first, payload, third || "tool");
  if (second === "end") return cmdEnd(first, payload, cfg);
}
function invokedDirectly() {
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
  main(process.argv.slice(2)).catch((err) => {
    const message = errorMessage(err);
    if (interactive) {
      process.stderr.write(`shyre: ${message}
`);
      process.exitCode = 1;
    } else {
      logRefusal(`internal: ${err instanceof Error ? err.stack || message : message}`);
    }
  }).finally(() => {
    if (!interactive) process.exitCode = 0;
  });
}
export {
  AGENT_LABELS,
  COVERAGE_MAX_PAGES,
  COVERAGE_PAGE_SIZE,
  DEFAULT_API_URL,
  DROP_GIVE_UP_ATTEMPTS,
  DROP_GIVE_UP_DAYS,
  DROP_REPORT_PATH,
  HOOK_WIRING,
  MAX_IDLE_CAP_SECONDS,
  MAX_TRIES,
  POST_INSTALL_NOTES,
  PROMPT_MARKS_MAX,
  PRUNE_AFTER_DAYS,
  STDIN_MAX_BYTES,
  VERSION,
  backfillOptions,
  buildEntryBody,
  claudeShapedHooks,
  cmdBackfill,
  cmdBeat,
  cmdEnd,
  cmdFlush,
  cmdInstall,
  cmdStart,
  cursorHooks,
  deliver,
  detectAgent,
  doctorLines,
  earliestFreeStart,
  fetchCoverage,
  formatBackfillPlan,
  gitRemote,
  hooksSessionMoving,
  installCodex,
  installCursor,
  installOrigin,
  isAgent,
  labelSetClose,
  logRefusal,
  main,
  mapFileCandidates,
  marksFromTranscriptEvents,
  metersFor,
  nodeCommand,
  normalizePayload,
  parseMarks,
  parseSessionTokens,
  pickTranscriptEvent,
  planBackfill,
  prometheusPort,
  promptMarksFor,
  readConfig,
  readTranscriptSessions,
  refusalLogPath,
  repoKeyFromRemote,
  resolveFromMap,
  scrapeSessionTokens,
  segmentRuns,
  shyreHome,
  tokensDoctorLine,
  uncoveredMillis,
  uncoveredSegments,
  uninstallCodex,
  uninstallCursor,
  validApiUrl
};
