#!/usr/bin/env node
// Quota probe for the delegate skill. Each executor leaves different local evidence
// behind — Codex writes rate-limit percentages into its rollout logs, Claude Code
// accounts answer Anthropic's OAuth usage endpoint (with transcript token burn as the
// fallback when that fails), Kimi leaves nothing at all — so this normalises all of it
// into one quota.json that the progress board's Quota tab reads.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const FIVE_HOURS = 300;
const ONE_WEEK = 10080;

const USAGE_ERROR_HINT = /usage limit|quota|rate.?limit|\b403\b/i;

const HELP = `quota-probe — collect local quota/usage evidence for the delegate executors

Usage:
  node quota-probe.mjs [--out <dir>]

Options:
  --out <dir>   Directory to write quota.json into (default: current directory)
  --help        Show this message

Writes <dir>/quota.json atomically. Exits 0 even when a single agent's data is
unreadable — that agent is reported with state "unknown" instead.
`;

function parseArgs(argv) {
  const args = { out: process.cwd(), help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--out') args.out = argv[++i] ?? args.out;
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
  }
  return args;
}

function localIso(date = new Date()) {
  const pad = (n, width = 2) => String(Math.abs(n)).padStart(width, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.trunc(offsetMinutes / 60))}:${pad(offsetMinutes % 60)}`
  );
}

function statOrNull(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function readdirOrEmpty(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function* walkFiles(dir, matches, depth = 12) {
  for (const entry of readdirOrEmpty(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) yield* walkFiles(full, matches, depth - 1);
    } else if (entry.isFile() && matches(entry.name)) {
      yield full;
    }
  }
}

async function eachLine(file, onLine) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) onLine(line);
  } finally {
    rl.close();
  }
}

// --- Codex -----------------------------------------------------------------

function codexWindowLabel(minutes) {
  if (minutes === FIVE_HOURS) return '5h';
  if (minutes === ONE_WEEK) return 'Weekly';
  return `${Math.round(minutes / 60)}h`;
}

function codexWindow(slot) {
  if (!slot || typeof slot.window_minutes !== 'number') return null;
  return {
    label: codexWindowLabel(slot.window_minutes),
    usedPercent: typeof slot.used_percent === 'number' ? slot.used_percent : null,
    windowMinutes: slot.window_minutes,
    resetsAt: typeof slot.resets_at === 'number' ? new Date(slot.resets_at * 1000).toISOString() : null,
  };
}

function unknownCodex(observedAt) {
  return {
    id: 'codex',
    label: 'Codex',
    kind: 'percent',
    state: 'unknown',
    plan: null,
    windows: [],
    source: '~/.codex/sessions newest rollout',
    observedAt,
  };
}

async function collectCodex(observedAt) {
  const sessions = path.join(os.homedir(), '.codex', 'sessions');
  let newest = null;
  for (const file of walkFiles(sessions, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'))) {
    const stat = statOrNull(file);
    if (!stat) continue;
    if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: stat.mtimeMs };
  }
  if (!newest) return unknownCodex(observedAt);

  let record = null;
  await eachLine(newest.file, (line) => {
    if (line.indexOf('"token_count"') === -1) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const payload = parsed && parsed.payload;
    if (!payload || payload.type !== 'token_count' || !payload.rate_limits) return;
    record = parsed;
  });
  if (!record) return unknownCodex(observedAt);

  const limits = record.payload.rate_limits;
  // Codex does not keep the 5h window in a fixed slot — a session that has only hit
  // the weekly limit reports it as "primary" — so the label comes from window_minutes,
  // and the windows are sorted shortest-first to keep the board's column order stable.
  const windows = [codexWindow(limits.primary), codexWindow(limits.secondary)]
    .filter(Boolean)
    .sort((a, b) => a.windowMinutes - b.windowMinutes);
  const exhausted = windows.some((w) => typeof w.usedPercent === 'number' && w.usedPercent >= 100);

  return {
    id: 'codex',
    label: 'Codex',
    kind: 'percent',
    state: limits.rate_limit_reached_type != null || exhausted ? 'limited' : 'ok',
    plan: limits.plan_type ?? null,
    windows,
    source: '~/.codex/sessions newest rollout',
    observedAt: typeof record.timestamp === 'string' ? record.timestamp : observedAt,
  };
}

// --- Claude Code -----------------------------------------------------------

function isRateLimitError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.status === 429) return true;
  return typeof error.message === 'string' && error.message.includes('rate_limit_error');
}

function claudeAgent(id, label, root, state, windows, lastRateLimitAt, observedAt) {
  return {
    id,
    label,
    kind: 'tokens',
    state,
    windows,
    lastRateLimitAt,
    source: `${root}/projects/**/*.jsonl`,
    observedAt,
  };
}

async function collectClaude(id, label, home, sourceLabel, observedAt) {
  const projects = path.join(home, 'projects');
  const now = Date.now();
  const weekCutoff = now - ONE_WEEK * 60_000;
  const fiveHourCutoff = now - FIVE_HOURS * 60_000;
  const totals = {
    [FIVE_HOURS]: { tokens: 0, messages: 0 },
    [ONE_WEEK]: { tokens: 0, messages: 0 },
  };
  const emptyWindows = () => [
    { label: '5h', tokens: 0, messages: 0, windowMinutes: FIVE_HOURS },
    { label: '7d', tokens: 0, messages: 0, windowMinutes: ONE_WEEK },
  ];

  if (!statOrNull(projects)) {
    // Account 2 is not provisioned on every machine; that is not an error, just no data.
    return claudeAgent(id, label, sourceLabel, 'unknown', emptyWindows(), null, observedAt);
  }

  let lastRateLimitMs = null;
  for (const file of walkFiles(projects, (name) => name.endsWith('.jsonl'))) {
    const stat = statOrNull(file);
    // Transcripts are append-only, so a file untouched since the widest window began
    // cannot contain an in-window line and never needs opening. This is what keeps the
    // probe fast over a multi-gigabyte transcript tree.
    if (!stat || stat.mtimeMs < weekCutoff) continue;
    try {
      await eachLine(file, (line) => {
        const hasUsage = line.indexOf('"output_tokens"') !== -1;
        const hasApiError = line.indexOf('"api_error"') !== -1;
        if (!hasUsage && !hasApiError) return;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          return;
        }
        const at = Date.parse(record.timestamp);
        if (!Number.isFinite(at) || at < weekCutoff) return;

        const usage = record.message && record.message.usage;
        if (usage && typeof usage === 'object') {
          const tokens =
            (usage.input_tokens || 0) +
            (usage.output_tokens || 0) +
            (usage.cache_creation_input_tokens || 0) +
            (usage.cache_read_input_tokens || 0);
          totals[ONE_WEEK].tokens += tokens;
          totals[ONE_WEEK].messages += 1;
          if (at >= fiveHourCutoff) {
            totals[FIVE_HOURS].tokens += tokens;
            totals[FIVE_HOURS].messages += 1;
          }
          return;
        }
        if (record.type === 'system' && record.subtype === 'api_error' && isRateLimitError(record.error)) {
          if (lastRateLimitMs === null || at > lastRateLimitMs) lastRateLimitMs = at;
        }
      });
    } catch {
      // One unreadable transcript must not cost us the rest of the account's usage.
      continue;
    }
  }

  const lastRateLimitAt = lastRateLimitMs === null ? null : new Date(lastRateLimitMs).toISOString();
  const limited = lastRateLimitMs !== null && lastRateLimitMs >= now - 60 * 60_000;
  const windows = [
    { label: '5h', tokens: totals[FIVE_HOURS].tokens, messages: totals[FIVE_HOURS].messages, windowMinutes: FIVE_HOURS },
    { label: '7d', tokens: totals[ONE_WEEK].tokens, messages: totals[ONE_WEEK].messages, windowMinutes: ONE_WEEK },
  ];
  return claudeAgent(id, label, sourceLabel, limited ? 'limited' : 'ok', windows, lastRateLimitAt, observedAt);
}

// --- Claude OAuth usage ------------------------------------------------------
// Nothing in this section may put a token anywhere except back into the credential
// store it came from — or, when that store rejects the write after a rotation, the
// mode-600 rescue file beside it — not in quota.json, not in stdout/stderr, not in
// error text.

// Claude Code's own OAuth client id. The usage endpoint is a plan-status call, not
// inference, so it still answers when the account itself is rate-limited.
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// The refresh host has moved between console.anthropic.com and platform.claude.com,
// so both are tried in order.
const TOKEN_URLS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
];
// One deadline covers an account's whole OAuth sequence — the refresh attempts and
// the usage fetch all share it — so slow hosts cannot stack timeouts past ~8s.
const ACCOUNT_TIMEOUT_MS = 8000;

function debug(message) {
  if (process.env.QUOTA_PROBE_DEBUG) process.stderr.write(`quota-probe: ${message}\n`);
}

// Claude Code keeps the default config dir's credentials under the bare service name
// and every CLAUDE_CONFIG_DIR override under a service suffixed with the first eight
// hex chars of sha256(configDir) — verified against the entries on this machine.
function keychainService(configDir, defaultStore) {
  if (defaultStore) return 'Claude Code-credentials';
  const suffix = crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
}

function acquireLock(configDir) {
  const lockPath = path.join(configDir, '.quota-probe.lock');
  const nonce = crypto.randomUUID();
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
  } catch {
    return null;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
  } catch {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(lockPath);
    } catch {}
    return null;
  }
  try {
    fs.closeSync(fd);
  } catch {
  }
  return { lockPath, nonce };
}

function releaseLock(lock) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'));
  } catch {
    debug('lock release skipped: lock could not be read and parsed');
    return;
  }
  if (!parsed || typeof parsed.nonce !== 'string' || parsed.nonce !== lock.nonce) {
    debug('lock release skipped: lock nonce did not match');
    return;
  }
  // With probe reclaim deleted, only owner release or the single loop janitor can
  // remove it; the janitor only removes >10m locks while probes finish in seconds,
  // so the matched file cannot be replaced between match and unlink.
  try {
    fs.unlinkSync(lock.lockPath);
  } catch {}
}

function fsyncDirectory(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Best-effort: the rename itself already landed; a directory that cannot be
    // fsynced must not cost us the only copy of a rotated token.
  }
}

// Atomic AND durable: the temp file is fsynced before the rename and the directory
// after it, so a crash right after this returns cannot lose what was written.
function writeFileDurable(target, body) {
  const temp = `${target}.${process.pid}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(temp, 'w', 0o600);
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, target);
    fs.chmodSync(target, 0o600);
    fsyncDirectory(path.dirname(target));
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
}

// A hung `security` call must not outlive the account's ~8s budget (let alone the
// 60s lock): every spawn gets a hard timeout derived from the remaining budget,
// floored at 2s so a call started near the deadline still gets a real chance. A
// timed-out call comes back with a null status — never 0, never 44 — so it flows
// down the same non-not-found failure paths as any other keychain error
// (account-unavailable on read, persist-failure/rescue on write).
function securityOpts(deadline) {
  return { encoding: 'utf8', timeout: Math.max(2000, deadline - Date.now()), killSignal: 'SIGKILL' };
}

// The account attribute must round-trip on rewrite, or the keychain entry forks in
// two. The metadata form of find-generic-password prints it as an "acct"<blob>="…"
// attribute line; anything else — non-zero exit, <NULL>, a hex blob — is "unknown",
// and an unknown account forbids rewriting the entry.
function keychainAccount(service, deadline) {
  const meta = spawnSync('security', ['find-generic-password', '-s', service], securityOpts(deadline));
  if (meta.status !== 0) return null;
  for (const line of (meta.stdout || '').split('\n')) {
    const match = /^\s*"acct"<blob>="(.*)"\s*$/.exec(line);
    if (match) return match[1];
  }
  return null;
}

function loadCredentials(configDir, defaultStore, deadline) {
  if (process.platform === 'darwin') {
    const service = keychainService(configDir, defaultStore);
    const secret = spawnSync('security', ['find-generic-password', '-s', service, '-w'], securityOpts(deadline));
    if (secret.status === 0) {
      let json;
      try {
        json = JSON.parse(secret.stdout.trim());
      } catch {
        return { unavailable: true };
      }
      return { json, store: { type: 'keychain', service, account: keychainAccount(service, deadline), configDir } };
    }
    // Only a definite "no such item" may fall through to the credentials file. Any
    // other keychain failure (locked, denied, transient) means the authoritative copy
    // is unreachable — refreshing from the file would leave the keychain holding a
    // dead refresh token — so the account sits this run out instead.
    const notFound = secret.status === 44 || /could not be found/i.test(secret.stderr || '');
    if (!notFound) return { unavailable: true };
  }
  const file = path.join(configDir, '.credentials.json');
  try {
    return { json: JSON.parse(fs.readFileSync(file, 'utf8')), store: { type: 'file', file, configDir } };
  } catch {
    return null;
  }
}

// Re-reading the store has three distinct outcomes and callers must be able to tell
// them apart: 'ok' carries the blob, 'not-found' means the store is definitely empty,
// 'error' means we simply do not know (locked keychain, timeout — status is null on a
// killed spawn — unreadable or corrupt file). Reads may degrade on the last two;
// writes may not, because "unknown" and "unchanged" are not the same store.
function reloadStore(store, deadline) {
  if (store.type === 'keychain') {
    const secret = spawnSync('security', ['find-generic-password', '-s', store.service, '-w'], securityOpts(deadline));
    if (secret.status !== 0) {
      const notFound = secret.status === 44 || /could not be found/i.test(secret.stderr || '');
      return { outcome: notFound ? 'not-found' : 'error' };
    }
    try {
      return { outcome: 'ok', json: JSON.parse(secret.stdout.trim()) };
    } catch {
      return { outcome: 'error' };
    }
  }
  let raw;
  try {
    raw = fs.readFileSync(store.file, 'utf8');
  } catch (error) {
    return { outcome: error && error.code === 'ENOENT' ? 'not-found' : 'error' };
  }
  try {
    return { outcome: 'ok', json: JSON.parse(raw) };
  } catch {
    return { outcome: 'error' };
  }
}

function reloadedBlob(reloaded) {
  return reloaded.outcome === 'ok' && reloaded.json && typeof reloaded.json === 'object' ? reloaded.json : null;
}

function persistCredentials(store, json, deadline) {
  const body = JSON.stringify(json);
  if (store.type === 'keychain') {
    // An add without -a would fork the entry instead of updating it in place.
    if (!store.account) return false;
    // macOS `security add-generic-password` cannot take -w from stdin
    // non-interactively, so the secret passing through argv here is a decision, not
    // an oversight — accepted on this single-user machine.
    const args = ['add-generic-password', '-U', '-s', store.service, '-a', store.account, '-w', body];
    return spawnSync('security', args, securityOpts(deadline)).status === 0;
  }
  return writeFileDurable(store.file, body);
}

// Last resort after a rotation: the refresh already invalidated the old refresh
// token, so if the origin store rejects the write the new blob must still reach disk
// before this process exits, or the account gets logged out.
function rescueCredentials(configDir, json) {
  const target = path.join(configDir, '.credentials.rescue.json');
  return writeFileDurable(target, JSON.stringify(json)) ? target : null;
}

// Every "we will not write the store" branch ends here: loud on stderr, and never
// carrying a token — only the reason and the path the rotation landed in.
function rescueRotation(id, configDir, updated, reason) {
  const rescue = rescueCredentials(configDir, updated);
  if (rescue) {
    process.stderr.write(
      `quota-probe: WARNING: ${id}: ${reason} — store left untouched; this probe's rotation saved to ` +
        `${rescue}; restore it into the credential store\n`,
    );
    return true;
  }
  debug(`${id}: ${reason} — rescue write also failed; probe rotation discarded`);
  return false;
}

async function postRefresh(refreshToken, deadline) {
  for (const url of TOKEN_URLS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: OAUTH_CLIENT_ID }),
        signal: AbortSignal.timeout(remaining),
      });
      // Any non-2xx here may just be this host misbehaving — try the other one.
      if (!res.ok) continue;
      const body = await res.json();
      // A rotation that comes back malformed must not overwrite a store that still
      // holds a working refresh token. Whitespace-only tokens count as malformed;
      // the trimmed values are what flows downstream.
      if (!body || typeof body !== 'object') return null;
      const accessToken = typeof body.access_token === 'string' ? body.access_token.trim() : '';
      const newRefreshToken = typeof body.refresh_token === 'string' ? body.refresh_token.trim() : '';
      if (accessToken.length === 0 || newRefreshToken.length === 0) return null;
      if (typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0) return null;
      return { ...body, access_token: accessToken, refresh_token: newRefreshToken };
    } catch {
      // Host unreachable — the other one may still answer.
    }
  }
  return null;
}

function usableStoredToken(oauth) {
  return (
    oauth &&
    typeof oauth === 'object' &&
    typeof oauth.accessToken === 'string' &&
    oauth.accessToken !== '' &&
    typeof oauth.expiresAt === 'number' &&
    oauth.expiresAt > Date.now() + 60_000
  );
}

async function freshAccessToken(id, creds, deadline) {
  const oauth = creds.json.claudeAiOauth;
  if (usableStoredToken(oauth)) {
    debug(`${id}: using stored access token (valid ${Math.round((oauth.expiresAt - Date.now()) / 60_000)}m)`);
    return oauth.accessToken;
  }
  if (typeof oauth.refreshToken !== 'string' || !oauth.refreshToken) return null;
  if (creds.store.type === 'keychain' && !creds.store.account) {
    // Without the account attribute the refreshed blob cannot be written back to the
    // right entry, and a refresh that cannot persist would burn the rotation.
    debug(`${id}: keychain account attribute unknown — not refreshing this run`);
    return null;
  }
  // Someone else (Claude Code, another probe) may have refreshed since our first
  // read; their rotation is authoritative, so use their token instead of burning it.
  // A read may degrade: if the store cannot be re-read we simply keep the copy from
  // this run's first read and go on to refresh. Nothing is written on this path.
  const rereadBlob = reloadedBlob(reloadStore(creds.store, deadline));
  const latest =
    rereadBlob && rereadBlob.claudeAiOauth && typeof rereadBlob.claudeAiOauth === 'object'
      ? rereadBlob.claudeAiOauth
      : oauth;
  if (usableStoredToken(latest)) {
    debug(`${id}: store already holds a fresh token — refresh skipped`);
    return latest.accessToken;
  }
  const refreshToken =
    typeof latest.refreshToken === 'string' && latest.refreshToken ? latest.refreshToken : oauth.refreshToken;
  const fresh = await postRefresh(refreshToken, deadline);
  if (!fresh) {
    debug(`${id}: token expired and refresh refused`);
    return null;
  }
  // The refresh rotates the refresh token, and losing the new one logs the user's
  // Claude Code out. Persist over a fresh read of the store so sibling keys written
  // meanwhile (mcpOAuth etc.) survive; only claudeAiOauth's token fields change.
  const rotate = (blob) => ({
    ...blob,
    claudeAiOauth: {
      ...(blob.claudeAiOauth && typeof blob.claudeAiOauth === 'object' ? blob.claudeAiOauth : oauth),
      accessToken: fresh.access_token,
      refreshToken: fresh.refresh_token,
      expiresAt: Date.now() + fresh.expires_in * 1000,
    },
  });
  const reloaded = reloadStore(creds.store, deadline);
  const base = reloadedBlob(reloaded);
  // A write demands certainty. If the store could not be re-read — unreachable, or
  // gone — there is no way to tell whose generation is sitting in it, and writing a
  // guess could clobber a newer one or resurrect a deleted store. So nothing is
  // written and the rotation goes to the rescue file, over this run's first read (the
  // most complete blob we hold); a stale snapshot is good enough to hand back to the
  // user, never good enough to write.
  if (!base) {
    rescueRotation(
      id,
      creds.store.configDir,
      rotate(creds.json),
      `credential store could not be re-read before writing the rotated token (${reloaded.outcome})`,
    );
    return fresh.access_token;
  }
  const baseOauth = base.claudeAiOauth && typeof base.claudeAiOauth === 'object' ? base.claudeAiOauth : oauth;
  const updated = rotate(base);
  // Persist-time CAS: only write the store if its refresh token is still the one this
  // probe sent to the refresh endpoint — then our rotation is that token's successor.
  // Anything else means Claude Code (or another probe) rotated meanwhile; their
  // generation stays in the store and ours is preserved in the rescue file instead.
  // Pre-refresh reload failure may use the stored refresh token.
  // A stale sent token is either rejected by the server or caught by persist-time CAS as a foreign successor.
  if (baseOauth.refreshToken !== refreshToken) {
    rescueRotation(id, creds.store.configDir, updated, 'credential store was rotated by another writer during refresh');
    return fresh.access_token;
  }
  if (!persistCredentials(creds.store, updated, deadline)) {
    if (rescueRotation(id, creds.store.configDir, updated, 'credential store write failed after token rotation')) {
      return fresh.access_token;
    }
    return null;
  }
  debug(`${id}: refreshed token and persisted to ${creds.store.type}`);
  return fresh.access_token;
}

async function fetchUsage(token, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const res = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(remaining),
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body && typeof body === 'object' ? body : null;
}

function isoOrNull(value) {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

// The endpoint is undocumented, so no reported number is trusted blindly: a window
// only makes the board if its percent is a finite non-negative number. Values a hair
// over 100 clamp down to 100; negatives and NaN drop the window entirely.
function usagePercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(value, 100);
}

// A null resets_at just drops the countdown field — the bar itself stays.
function usageWindow(label, minutes, percent, resetsAtRaw) {
  const window = { label, usedPercent: percent, windowMinutes: minutes };
  const resetsAt = isoOrNull(resetsAtRaw);
  if (resetsAt !== null) window.resetsAt = resetsAt;
  return window;
}

function limitsWindows(body) {
  const windows = [];
  if (!Array.isArray(body.limits)) return windows;
  for (const entry of body.limits) {
    if (!entry || typeof entry !== 'object') continue;
    const percent = usagePercent(entry.percent);
    if (percent === null) continue;
    const kind = typeof entry.kind === 'string' ? entry.kind : '';
    let label = kind || 'window';
    let minutes = null;
    if (kind === 'session' || entry.group === 'session') {
      label = '5h';
      minutes = FIVE_HOURS;
    } else if (kind === 'weekly_scoped') {
      const model = entry.scope && entry.scope.model && (entry.scope.model.display_name || entry.scope.model.id);
      label = model ? `Weekly · ${model}` : 'Weekly · model';
      minutes = ONE_WEEK;
    } else if (kind === 'weekly_all' || entry.group === 'weekly') {
      label = 'Weekly';
      minutes = ONE_WEEK;
    }
    windows.push(usageWindow(label, minutes, percent, entry.resets_at));
  }
  return windows;
}

function namedWindows(body) {
  const windows = [];
  for (const [key, value] of Object.entries(body)) {
    if (!value || typeof value !== 'object') continue;
    const percent = usagePercent(value.utilization);
    if (percent === null) continue;
    let label = null;
    if (key === 'five_hour') label = '5h';
    else if (key === 'seven_day') label = 'Weekly';
    else {
      const model = /^seven_day_(.+)$/.exec(key);
      if (model) label = `Weekly · ${model[1].charAt(0).toUpperCase()}${model[1].slice(1)}`;
    }
    if (!label) continue;
    windows.push(usageWindow(label, label === '5h' ? FIVE_HOURS : ONE_WEEK, percent, value.resets_at));
  }
  return windows;
}

function usageWindows(body) {
  // The `limits` array is today's richest shape, but it has shipped incomplete: when
  // it carries no session window while a top-level five_hour object exists, the older
  // top-level named windows fill the gaps (limits entries win on label collision).
  const windows = limitsWindows(body);
  const hasSession = windows.some((w) => w.windowMinutes === FIVE_HOURS);
  if (!windows.length || (!hasSession && body.five_hour && typeof body.five_hour === 'object')) {
    const labels = new Set(windows.map((w) => w.label));
    for (const window of namedWindows(body)) {
      if (!labels.has(window.label)) windows.push(window);
    }
  }
  return windows.sort((a, b) => (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity));
}

async function collectClaudePercent(acct) {
  // No config dir means the account is not provisioned on this machine; skipping the
  // credential lookup here is also what keeps runs under a foreign HOME offline.
  if (!statOrNull(acct.configDir)) return null;
  const lock = acquireLock(acct.configDir);
  if (!lock) {
    debug(`${acct.id}: another probe holds the credential lock — skipping OAuth this run`);
    return null;
  }
  const deadline = Date.now() + ACCOUNT_TIMEOUT_MS;
  let token = null;
  let plan = null;
  try {
    const creds = loadCredentials(acct.configDir, acct.defaultStore, deadline);
    if (!creds) {
      debug(`${acct.id}: no stored credentials`);
      return null;
    }
    if (creds.unavailable) {
      debug(`${acct.id}: credential store unreadable this run — leaving it untouched`);
      return null;
    }
    const oauth = creds.json && creds.json.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string') {
      debug(`${acct.id}: no stored credentials`);
      return null;
    }
    plan = typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null;
    token = await freshAccessToken(acct.id, creds, deadline);
  } finally {
    releaseLock(lock);
  }
  if (!token) return null;
  const body = await fetchUsage(token, deadline);
  if (!body) {
    debug(`${acct.id}: usage endpoint gave no usable answer`);
    return null;
  }
  const windows = usageWindows(body);
  if (!windows.length) {
    debug(`${acct.id}: usage response had no recognisable windows`);
    return null;
  }
  debug(`${acct.id}: usage fetched (${windows.length} windows)`);
  return {
    plan,
    state: windows.some((w) => w.usedPercent >= 100) ? 'limited' : 'ok',
    windows,
  };
}

async function collectClaudeAccount(acct, observedAt) {
  // The transcript scan always runs: it is the whole fallback card on any OAuth
  // failure, and the source of lastRateLimitAt even when the usage fetch succeeds.
  const [burn, percent] = await Promise.all([
    collectClaude(acct.id, acct.label, acct.configDir, acct.sourceLabel, observedAt),
    safely(() => collectClaudePercent(acct), null),
  ]);
  if (!percent) return burn;
  return {
    id: acct.id,
    label: acct.label,
    kind: 'percent',
    state: percent.state,
    plan: percent.plan,
    windows: percent.windows,
    lastRateLimitAt: burn.lastRateLimitAt,
    source: 'api.anthropic.com/api/oauth/usage',
    observedAt,
  };
}

// --- Kimi ------------------------------------------------------------------

function newestResultJson(dir, depth, best) {
  for (const entry of readdirOrEmpty(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) best = newestResultJson(full, depth - 1, best);
    } else if (entry.name === 'result.json') {
      const stat = statOrNull(full);
      if (stat && (!best || stat.mtimeMs > best.mtimeMs)) best = { file: full, mtimeMs: stat.mtimeMs };
    }
  }
  return best;
}

function findKimiResult() {
  const tmp = os.tmpdir();
  const deadline = Date.now() + 400;
  let best = null;
  for (const entry of readdirOrEmpty(tmp)) {
    if (!entry.isDirectory()) continue;
    const full = path.join(tmp, entry.name);
    if (/kimi/i.test(entry.name)) {
      best = newestResultJson(full, 3, best);
      continue;
    }
    // The relay sometimes nests its run dir one level down. The system temp dir holds
    // hundreds of unrelated directories, so this second level runs under a time budget:
    // Kimi's state is a nice-to-have and must never hold up the other three agents.
    if (Date.now() > deadline) break;
    for (const nested of readdirOrEmpty(full)) {
      if (nested.isDirectory() && /kimi/i.test(nested.name)) {
        best = newestResultJson(path.join(full, nested.name), 2, best);
      }
    }
  }
  return best;
}

function collectKimi(observedAt) {
  const agent = {
    id: 'kimi',
    label: 'Kimi K3',
    kind: 'status',
    state: 'unknown',
    windows: [],
    note: 'Kimi exposes no local quota data — state comes from the last relay result',
    lastRateLimitAt: null,
    source: 'relay result.json',
    observedAt,
  };

  const result = findKimiResult();
  if (!result) return agent;

  let text = '';
  try {
    const fd = fs.openSync(result.file, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      text = buffer.toString('utf8', 0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return agent;
  }

  const looksLimited = USAGE_ERROR_HINT.test(text);
  const recent = result.mtimeMs >= Date.now() - 6 * 60 * 60_000;
  if (looksLimited && recent) {
    agent.state = 'limited';
    agent.lastRateLimitAt = new Date(result.mtimeMs).toISOString();
  } else if (!looksLimited) {
    agent.state = 'ok';
  }
  // A limit hit older than six hours is stale evidence, so the agent stays "unknown"
  // rather than claiming a block that has almost certainly expired.
  return agent;
}

// --- Output ----------------------------------------------------------------

function writeAtomic(outDir, payload) {
  fs.mkdirSync(outDir, { recursive: true });
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  // Two mirrors of the same data: quota.json for http readers, and quota.js
  // for boards opened as plain file:// pages, where fetch() is blocked but a
  // relative <script src> still loads.
  const outputs = [
    ['quota.json', json],
    ['quota.js', `window.__QUOTA__ = ${json.trimEnd()};\n`],
  ];
  let target = null;
  for (const [name, body] of outputs) {
    const file = path.join(outDir, name);
    const temp = path.join(outDir, `.${name}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(temp, body);
      // Rename is atomic within a directory, so the board never reads a half-written file.
      fs.renameSync(temp, file);
    } finally {
      try {
        fs.unlinkSync(temp);
      } catch {}
    }
    target = target ?? file;
  }
  return target;
}

async function safely(collect, fallback) {
  try {
    return await collect();
  } catch {
    return fallback;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const observedAt = localIso();
  const home = os.homedir();
  const claudeA = {
    id: 'claude-a', label: 'Claude Code — main',
    configDir: path.join(home, '.claude'), sourceLabel: '~/.claude', defaultStore: true,
  };
  const claudeB = {
    id: 'claude-b', label: 'Claude Code — account 2',
    configDir: path.join(home, '.claude-acc2'), sourceLabel: '~/.claude-acc2', defaultStore: false,
  };
  const agents = await Promise.all([
    safely(() => collectCodex(observedAt), unknownCodex(observedAt)),
    safely(
      () => collectClaudeAccount(claudeA, observedAt),
      claudeAgent('claude-a', 'Claude Code — main', '~/.claude', 'unknown', [
        { label: '5h', tokens: 0, messages: 0, windowMinutes: FIVE_HOURS },
        { label: '7d', tokens: 0, messages: 0, windowMinutes: ONE_WEEK },
      ], null, observedAt),
    ),
    safely(
      () => collectClaudeAccount(claudeB, observedAt),
      claudeAgent('claude-b', 'Claude Code — account 2', '~/.claude-acc2', 'unknown', [
        { label: '5h', tokens: 0, messages: 0, windowMinutes: FIVE_HOURS },
        { label: '7d', tokens: 0, messages: 0, windowMinutes: ONE_WEEK },
      ], null, observedAt),
    ),
    safely(async () => collectKimi(observedAt), {
      id: 'kimi',
      label: 'Kimi K3',
      kind: 'status',
      state: 'unknown',
      windows: [],
      note: 'Kimi exposes no local quota data — state comes from the last relay result',
      lastRateLimitAt: null,
      source: 'relay result.json',
      observedAt,
    }),
  ]);

  const target = writeAtomic(args.out, { updatedAt: localIso(), agents });
  process.stdout.write(`${target}\n`);
}

main().catch((error) => {
  process.stderr.write(`quota-probe failed: ${error && error.message ? error.message : error}\n`);
  process.exit(1);
});
