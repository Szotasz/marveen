/**
 * The git half of the personal-data gate: WHICH lines a push publishes, and whether
 * the place they go is public. The pure question ("is this text personal data?")
 * lives in pii-gate.ts; this file only decides what to hand it.
 *
 * Runs from the pre-push dispatcher (`scripts/secret-gate.ts --pushed`), so it sees
 * EVERY push git performs, whatever shape the command line had: `git push`,
 * `git -C x push`, `git push origin HEAD:topic`, a script calling `git push`, a
 * tool that shells out to it. A gate written against the command text sees only
 * the spellings its author thought of. A gate written against what git is about to
 * transmit sees the push.
 *
 * FAIL-CLOSED. Every step that cannot be completed is a BLOCK, not a pass:
 *   - the outgoing commit set cannot be computed      -> block
 *   - git cannot produce a patch or a message         -> block
 *   - the local denylist exists but does not parse    -> block
 *   - the exception table is malformed                -> block
 *   - the visibility of the target cannot be told     -> treated as PUBLIC
 * The last one is the point of the visibility probe: it can only RAISE strictness.
 * A private target downgrades a finding from "block" to "warn" only on a positive
 * answer (see probeVisibility); silence, an error or a rate limit never does.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import {
  EMPTY_DENYLIST, PII_EXCEPTIONS, invalidPiiExceptions, parseAddedLines, parseDenylist, piiExceptionReason, scanAdded,
  type AddedLine, type Denylist, type PiiException, type PiiFinding,
} from './pii-gate.js';

const ZERO = /^0+$/;
const CHUNK = 100;
const GIT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 512 * 1024 * 1024;

export interface RefUpdate {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

/** The stdin git feeds a pre-push hook: `<local ref> <local sha> <remote ref> <remote sha>`. */
export function parseRefLines(stdin: string): RefUpdate[] {
  const out: RefUpdate[] = [];
  for (const raw of stdin.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 4 || !/^[0-9a-f]{40,64}$/.test(parts[1]) || !/^[0-9a-f]{40,64}$/.test(parts[3])) {
      throw new Error(`unparseable pre-push ref line (${parts.length} fields)`);
    }
    out.push({ localRef: parts[0], localSha: parts[1], remoteRef: parts[2], remoteSha: parts[3] });
  }
  return out;
}

// ── Visibility ──────────────────────────────────────────────────────────────

export type VisibilityState = 'public' | 'private' | 'unknown';
export interface Visibility { state: VisibilityState; reason: string }

/** `owner/repo` for a github.com remote in any of its URL spellings, else null. */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const m =
    /^(?:https?:\/\/(?:[^@/]*@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) =>
  Promise<{ status: number; json: () => Promise<unknown> }>;

/**
 * Is the target repository readable by ANYONE?
 *
 * The question is asked ANONYMOUSLY, on purpose, with no token. That makes the
 * answer mean "can a stranger read this?", which is the only question that matters
 * for exposure, and it removes the credential failure mode: an authenticated call
 * that answers 401/404 because the token is stale or the wrong account cannot be
 * told apart from a private repository.
 *   200 + private:false -> public
 *   404                 -> not publicly readable. For a repo we are pushing to, the
 *                          repo exists, so this is private.
 *   anything else       -> unknown (rate limit 403/429, 5xx, timeout, a host that is
 *                          not github.com, a body that does not parse)
 * `unknown` is handled as public by the caller. Never as private.
 */
export async function probeVisibility(
  url: string, fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs = 8000,
): Promise<Visibility> {
  const gh = parseGithubRemote(url);
  if (!gh) return { state: 'unknown', reason: 'the remote is not a github.com URL, so its visibility cannot be queried' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${gh.owner}/${gh.repo}`, {
      headers: { 'User-Agent': 'marveen-pii-gate', Accept: 'application/vnd.github+json' },
      signal: ctrl.signal,
    });
    if (res.status === 404) return { state: 'private', reason: `${gh.owner}/${gh.repo} is not anonymously readable (HTTP 404)` };
    if (res.status === 200) {
      const body = (await res.json()) as { private?: unknown };
      if (body && body.private === false) return { state: 'public', reason: `${gh.owner}/${gh.repo} is anonymously readable` };
      return { state: 'unknown', reason: 'HTTP 200 but the body does not say private:false' };
    }
    return { state: 'unknown', reason: `the visibility query answered HTTP ${res.status}` };
  } catch (e) {
    return { state: 'unknown', reason: `the visibility query failed (${(e as Error).name})` };
  } finally {
    clearTimeout(timer);
  }
}

// ── git plumbing ────────────────────────────────────────────────────────────

function git(args: string[], cwd: string, input?: string): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd, input, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function commitExists(sha: string, cwd: string): boolean {
  try { git(['cat-file', '-e', `${sha}^{commit}`], cwd); return true; } catch { return false; }
}

function remoteIsConfigured(name: string, cwd: string): boolean {
  try { return git(['remote'], cwd).split('\n').includes(name); } catch { return false; }
}

/**
 * The commits this ref update would send that the target does not already have.
 * Excludes the remote's old tip (when we have it) AND everything already reachable
 * from the remote's other tracked refs, so a new branch cut from a published base
 * is judged on its own commits only.
 */
export function outgoingCommits(u: RefUpdate, remoteName: string, cwd: string, trustTracking = true): string[] {
  const exclude: string[] = [];
  if (!ZERO.test(u.remoteSha) && commitExists(u.remoteSha, cwd)) exclude.push(u.remoteSha);
  // `trustTracking` is false when the remote's URL changed since the last run: the tracking refs
  // under that NAME then describe a different repository, and must not hide commits from it.
  if (trustTracking && remoteIsConfigured(remoteName, cwd)) exclude.push(`--remotes=${remoteName}`);
  const args = ['rev-list', '--reverse', u.localSha];
  if (exclude.length) args.push('--not', ...exclude);
  return git(args, cwd).split('\n').filter(Boolean);
}

/** Patches of a set of commits, framed by a per-run random marker line. */
function patchesFor(commits: string[], cwd: string, marker: string): Map<string, string> {
  const out = git(
    [
      'log', '--no-walk=unsorted', '--stdin', '-p', '--cc', '-U0', '--no-renames', '--no-color',
      // The repository's own diff configuration must not decide what the gate can SEE:
      //   --no-textconv / --no-ext-diff  a `diff=<driver>` attribute (.git/info/attributes, a
      //                                  committed .gitattributes) can rewrite or erase the patch
      //   --text                         a `-diff` attribute or a binary guess turns the patch
      //                                  into "Binary files differ" and hides every added line
      //   --src/dst-prefix               diff.noprefix / mnemonicPrefix change the file headers
      // Found by Sam on f03ac3cc: a textconv driver made an added e-mail vanish without a NOTE.
      '--no-textconv', '--no-ext-diff', '--text', '--src-prefix=a/', '--dst-prefix=b/',
      `--format=${marker}%H`,
    ],
    cwd, `${commits.join('\n')}\n`,
  );
  return splitByMarker(out, marker);
}

function messagesFor(commits: string[], cwd: string, marker: string): Map<string, string> {
  const out = git(
    ['log', '--no-walk=unsorted', '--stdin', '--no-color', `--format=${marker}%H%n%B`],
    cwd, `${commits.join('\n')}\n`,
  );
  return splitByMarker(out, marker);
}

/**
 * `<marker><sha>` starts each record.
 *
 * The marker is 128 random bits generated for THIS run. It cannot be guessed by
 * whoever wrote the commits, so no message or diff line can forge a record
 * boundary; and every diff line carries a one-character prefix, so a boundary at
 * the START of a line cannot occur inside a patch anyway. Splitting on a fixed
 * control byte at a line START (Szotasz's scan.ts, found by Sam as S1) only works
 * if git puts the byte there; this does not depend on where git puts anything but
 * the format string we handed it.
 */
export function splitByMarker(out: string, marker: string): Map<string, string> {
  const map = new Map<string, string>();
  // `(?<![^\\n])` = "at the start of the text or right after a newline", WITHOUT consuming
  // the newline. Consuming it lost the next record whenever a record had an empty
  // body (a merge with no combined diff): its trailing newline was swallowed by the
  // previous match and the next marker no longer sat at a line start.
  const re = new RegExp(`(?<![^\\n])${marker}([0-9a-f]{40,64})\\n?`, 'g');
  const marks: { sha: string; start: number; end: number }[] = [];
  for (const m of out.matchAll(re)) marks.push({ sha: m[1], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  marks.forEach((mk, i) => {
    const body = out.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : out.length);
    map.set(mk.sha, body);
  });
  return map;
}

function messageLines(sha: string, body: string): AddedLine[] {
  return body.replace(/\n+$/, '').split('\n').map((text, i) => ({ file: 'commit message', line: i + 1, text }));
}

// ── The run ─────────────────────────────────────────────────────────────────

export interface PushedInput {
  remoteName: string;
  remoteUrl: string;
  stdin: string;
  cwd: string;
  fetchImpl?: FetchLike;
  /** Test seam only; the production default reads the hooks directory. */
  denylist?: Denylist;
  exceptions?: readonly PiiException[];
  /** Set by --pii-range: no remote, no probe, strict. */
  skipProbe?: boolean;
}

export interface PushedResult { exitCode: 0 | 1 | 2; report: string }

function hooksDir(cwd: string): string {
  const common = git(['rev-parse', '--git-common-dir'], cwd).trim();
  return join(isAbsolute(common) ? common : join(cwd, common), 'hooks');
}

function loadDenylist(cwd: string): { denylist: Denylist; note: string } {
  const file = join(hooksDir(cwd), 'pii-denylist.txt');
  if (!existsSync(file)) {
    return { denylist: EMPTY_DENYLIST, note: 'no local denylist (hooks/pii-denylist.txt): NAMES are not detected, only shapes' };
  }
  return { denylist: parseDenylist(readFileSync(file, 'utf8')), note: `local denylist loaded (${file})` };
}

/** Scan a set of commits; returns findings, applied exceptions and unscanned binaries. */
export function scanCommits(
  commits: string[], cwd: string, denylist: Denylist, exceptions: readonly PiiException[],
): { findings: PiiFinding[]; exceptions: { file: string; line?: number; detector: string; reason: string }[] } {
  const findings: PiiFinding[] = [];
  const applied: { file: string; line?: number; detector: string; reason: string }[] = [];
  const marker = `PIIGATE-${randomBytes(16).toString('hex')}-`;
  for (let i = 0; i < commits.length; i += CHUNK) {
    const chunk = commits.slice(i, i + CHUNK);
    const patches = patchesFor(chunk, cwd, marker);
    const messages = messagesFor(chunk, cwd, marker);
    for (const sha of chunk) {
      const patch = patches.get(sha);
      const msg = messages.get(sha);
      if (patch === undefined || msg === undefined) {
        throw new Error(`git returned no ${patch === undefined ? 'patch' : 'message'} for commit ${sha.slice(0, 10)}`);
      }
      const short = sha.slice(0, 10);
      const parsed = parseAddedLines(patch);
      // A binary cannot be read by a text detector. It is not "a NOTE": an xlsx or a pdf full of
      // personal data would sail through a public push. It is a FINDING; a reviewed exception
      // names the exact blob (path + the sha256 of its git object id).
      for (const path of parsed.binary) {
        let oid = 'unresolved';
        try { oid = git(['rev-parse', `${sha}:${path}`], cwd).trim(); } catch { /* fail closed: no exception can match */ }
        const why = oid === 'unresolved' ? null : piiExceptionReason(path, oid, exceptions);
        if (why) applied.push({ file: path, detector: 'binary', reason: why });
        else findings.push({ file: path, detector: 'binary', commit: short, reason: `a binary file (blob ${oid.slice(0, 10)}): text detectors cannot read it` });
      }
      for (const r of [
        scanAdded(parsed.lines, short, { denylist, exceptions }),
        scanAdded(messageLines(sha, msg), short, { denylist, exceptions, messageMode: true }),
      ]) {
        findings.push(...r.findings);
        applied.push(...r.exceptions);
      }
    }
  }
  return { findings, exceptions: applied };
}

function describe(findings: PiiFinding[]): string[] {
  const lines: string[] = [];
  for (const f of findings.slice(0, 60)) {
    lines.push(`  ${f.commit ?? '?'}  ${f.file}${f.line ? `:${f.line}` : ''}  [${f.detector}]  ${f.reason}`);
  }
  if (findings.length > 60) lines.push(`  ... and ${findings.length - 60} more`);
  return lines;
}

/** Annotated-tag message lines (nested tags peeled). Empty for a branch or a lightweight tag. */
export function tagMessages(sha: string, cwd: string): AddedLine[] {
  const out: AddedLine[] = [];
  let cur = sha;
  for (let depth = 0; depth < 8; depth++) {
    let type = '';
    try { type = git(['cat-file', '-t', cur], cwd).trim(); } catch { break; }
    if (type !== 'tag') break;
    const raw = git(['cat-file', 'tag', cur], cwd);
    const cut = raw.indexOf('\n\n');
    const body = cut >= 0 ? raw.slice(cut + 2) : '';
    body.replace(/\n+$/, '').split('\n').forEach((text, i) => out.push({ file: 'tag message', line: i + 1, text }));
    const next = /^object ([0-9a-f]{40,64})$/m.exec(raw);
    if (!next) break;
    cur = next[1];
  }
  return out;
}

/**
 * Has the URL behind this remote NAME changed since the last run that PASSED for it?
 * The URL is stored as a hash (it can carry a token). First sight of a name counts as
 * "unchanged": there is no earlier record to compare with, and an existing install must not
 * rescan the world on its first push.
 *
 * READ-ONLY on purpose. The first version wrote the new URL into the record as soon as it
 * noticed the change -- before the scan -- so a push that was BLOCKED could be repeated
 * unchanged, the second attempt saw "unchanged", and the old tracking refs hid the commits
 * again (Sam, SULYOS 1). The record is written by `recordRemoteUrl`, only after a run that
 * let the push go; until then the state stays "changed".
 */
export function remoteUrlChanged(name: string, url: string, cwd: string): boolean {
  if (!name) return false;
  const known = readRemoteRecord(cwd);
  const now = createHash('sha256').update(url, 'utf8').digest('hex');
  return typeof known[name] === 'string' && known[name] !== now;
}

function remoteRecordFile(cwd: string): string {
  return join(hooksDir(cwd), 'pii-gate-remotes.json');
}

function readRemoteRecord(cwd: string): Record<string, string> {
  try { return JSON.parse(readFileSync(remoteRecordFile(cwd), 'utf8')) as Record<string, string>; } catch { return {}; }
}

/** Remember this URL for the remote name. Call it only after a run that did NOT block the push. */
export function recordRemoteUrl(name: string, url: string, cwd: string): void {
  if (!name) return;
  try {
    const known = readRemoteRecord(cwd);
    const now = createHash('sha256').update(url, 'utf8').digest('hex');
    if (known[name] === now) return;
    known[name] = now;
    const file = remoteRecordFile(cwd);
    writeFileSync(`${file}.tmp`, JSON.stringify(known));
    renameSync(`${file}.tmp`, file);
  } catch { /* an unwritable record only means the next run compares against the older one */ }
}

export async function runPushed(input: PushedInput): Promise<PushedResult> {
  const out: string[] = [];
  const say = (s = '') => out.push(s);
  try {
    const bad = invalidPiiExceptions(input.exceptions ?? PII_EXCEPTIONS);
    if (bad.length) {
      say('pii-gate: the exception table is malformed -- BLOCKING (fail-closed):');
      bad.forEach((b) => say(`  ${b.path}: ${b.reason}`));
      return { exitCode: 2, report: out.join('\n') };
    }

    const updates = input.stdin.trim() ? parseRefLines(input.stdin) : [];
    const live = updates.filter((u) => !ZERO.test(u.localSha));
    if (live.length === 0) return { exitCode: 0, report: '' };

    const dl = input.denylist ? { denylist: input.denylist, note: 'denylist supplied by the caller' } : loadDenylist(input.cwd);
    const vis: Visibility = input.skipProbe
      ? { state: 'unknown', reason: 'range audit: always strict' }
      : await probeVisibility(input.remoteUrl, input.fetchImpl);

    const all: PiiFinding[] = [];
    const exc: { file: string; line?: number; detector: string; reason: string }[] = [];
    let commitCount = 0;
    const urlChange = remoteUrlChanged(input.remoteName, input.remoteUrl, input.cwd);
    if (urlChange) say(`pii-gate: the URL behind remote "${input.remoteName}" changed since the last run -- its tracking refs describe another repository, so they hide nothing.`);
    for (const u of live) {
      // An annotated tag carries a MESSAGE that rev-list never shows; scan it, peeling nested tags.
      const tagMsg = tagMessages(u.localSha, input.cwd);
      if (tagMsg.length) {
        const r = scanAdded(tagMsg, u.localSha.slice(0, 10), { denylist: dl.denylist, exceptions: input.exceptions ?? PII_EXCEPTIONS, messageMode: true });
        all.push(...r.findings);
        exc.push(...r.exceptions);
      }
      const commits = outgoingCommits(u, input.remoteName, input.cwd, !urlChange);
      commitCount += commits.length;
      const r = scanCommits(commits, input.cwd, dl.denylist, input.exceptions ?? PII_EXCEPTIONS);
      all.push(...r.findings);
      exc.push(...r.exceptions);
    }

    const strict = vis.state !== 'private';
    say(`pii-gate: ${commitCount} outgoing commit(s) to "${input.remoteName}" -- target ${vis.state.toUpperCase()}: ${vis.reason}`);
    say(`pii-gate: ${dl.note}`);
    if (exc.length) {
      say(`Exceptions applied (${exc.length}) -- one literal each, re-read them:`);
      exc.forEach((e) => say(`  ${e.file}${e.line ? `:${e.line}` : ''}  [${e.detector}]  <- ${e.reason}`));
    }
    if (all.length === 0) {
      say('pii-gate: PASS -- no personal data in the lines or messages this push adds.');
      recordRemoteUrl(input.remoteName, input.remoteUrl, input.cwd);
      return { exitCode: 0, report: out.join('\n') };
    }
    say('');
    say(`${strict ? 'BLOCKED' : 'WARNING (private target, push allowed)'}: personal data in ${all.length} added line(s):`);
    describe(all).forEach((l) => say(l));
    say('');
    say('The matched text is deliberately not printed. Look at the commit, file and line above.');
    if (strict) {
      say('Fix it in the history that is pushed (amend / rebase your OWN unpublished commits) or make');
      say('the value synthetic. A deliberate, reviewed literal goes in PII_EXCEPTIONS in');
      say('src/security/pii-gate.ts as a sha256 + a written reason. There is no environment override.');
      say('Pushing a repository from private to public needs the same check over its WHOLE history:');
      say('  npx tsx scripts/secret-gate.ts --pii-range <rev-list args>');
    }
    if (!strict) recordRemoteUrl(input.remoteName, input.remoteUrl, input.cwd);
    return { exitCode: strict ? 1 : 0, report: out.join('\n') };
  } catch (e) {
    say(`pii-gate: could not complete the check -- BLOCKING (fail-closed): ${(e as Error).message}`);
    return { exitCode: 2, report: out.join('\n') };
  }
}

/** `--pii-range`: the same engine over any rev-list spec, for a pre-flip audit. */
export async function runRange(revArgs: string[], cwd: string): Promise<PushedResult> {
  const out: string[] = [];
  try {
    const commits = git(['rev-list', '--reverse', ...revArgs], cwd).split('\n').filter(Boolean);
    const dl = loadDenylist(cwd);
    const r = scanCommits(commits, cwd, dl.denylist, PII_EXCEPTIONS);
    out.push(`pii-gate: ${commits.length} commit(s) audited -- ${dl.note}`);
    if (r.findings.length === 0) {
      out.push('pii-gate: PASS');
      return { exitCode: 0, report: out.join('\n') };
    }
    out.push(`BLOCKED: personal data in ${r.findings.length} added line(s):`, ...describe(r.findings));
    return { exitCode: 1, report: out.join('\n') };
  } catch (e) {
    out.push(`pii-gate: could not complete the audit -- ${(e as Error).message}`);
    return { exitCode: 2, report: out.join('\n') };
  }
}
