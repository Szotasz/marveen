#!/usr/bin/env tsx
/**
 * EVIDGUARD818: the secret gate's runner. Two callers, one core.
 *
 *   scripts/secret-gate.ts --staged            (pre-commit hook: what is about to be committed)
 *   scripts/secret-gate.ts --range <base>..<head>   (CI: what the PR adds)
 *   scripts/secret-gate.ts --all               (audit: every tracked file)
 *
 * The hook is the fast lane and can be skipped with `git commit --no-verify`.
 * The CI run is the actual gate. That is stated here and in the PR template so
 * nobody mistakes the convenience for the control.
 *
 * Everything this runner cannot scan is REPORTED and FAILS. Size limits, binary
 * files, read errors: each is named. A silent skip would read as "clean".
 *
 * ── THE SOURCE OF TRUTH IS GIT OBJECT STORAGE, NEVER THE WORKING TREE ────────
 *
 * Found 2026-09-06 on PR #775, which was red for two weeks with NO secret in it.
 * The runner resolved each path with `readFileSync`, and two of the paths were
 * versioned symlinks pointing at directories (`releases/monitor-current`,
 * `releases/monitor-previous`, both mode 120000). `readFileSync` on those
 * follows the link into a directory and throws EISDIR, so the gate reported
 * "NOT SCANNED, therefore NOT CLEARED" and failed closed -- correctly, by its
 * own rule, on a question it had asked wrongly.
 *
 * The deeper problem is not the crash. Reading the working tree makes the gate
 * answer a question nobody asked: it scans whatever happens to be on this disk
 * right now, which in CI is a checkout and locally is an arbitrarily dirty tree.
 * What a range gate must scan is what the COMMITS CONTAIN. So every mode now
 * resolves content from git:
 *
 *   --range   the head tree of the range
 *   --staged  the index -- which is precisely "what is about to be committed",
 *             and is not the same thing as the working tree once a file has been
 *             edited after `git add`
 *   --all     the index
 *
 * A symlink is then scanned as what git actually stores for it: a small blob
 * holding the TARGET PATH as text. That is the honest object to scan. Following
 * it would scan a file the commit does not contain, and for a directory target
 * there is nothing to follow at all.
 */
import { execFileSync } from 'node:child_process';
import { runGate, type ScanInput, type GateResult } from '../src/security/secret-gate.js';

/** Beyond this the file is not scanned -- and therefore not cleared. */
const MAX_BYTES = 5 * 1024 * 1024;

/** Git file modes we can meet in a tree or the index. */
const MODE_SYMLINK = '120000';
const MODE_GITLINK = '160000';

interface Entry {
  path: string;
  /** Six-digit git mode: 100644, 100755, 120000, 160000. */
  mode: string;
  /** Blob sha. Empty for a gitlink, which has no blob in this repository. */
  sha: string;
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function gitBuf(args: string[], input?: string): Buffer {
  return execFileSync('git', args, { input, maxBuffer: 256 * 1024 * 1024 });
}

/** NUL-separated git output -> array, without an empty tail element. */
function splitZ(s: string): string[] {
  return s.split('\0').filter(Boolean);
}

/**
 * The head of a range, for `A..B` and `A...B` alike.
 *
 * `git diff` resolves `A...B` against the merge base, but in BOTH forms the side
 * whose content we must scan is B. Splitting on the LAST `..` gets that right
 * for both without special-casing.
 */
function headOfRange(range: string): string {
  const at = range.lastIndexOf('..');
  const head = range.slice(at + 2);
  if (!head) throw new Error(`--range needs <base>..<head>, got: ${range}`);
  return head;
}

/** `<mode> <type> <sha>\t<path>` records from `git ls-tree`. */
function parseLsTree(out: string): Entry[] {
  return splitZ(out).map((rec) => {
    const tab = rec.indexOf('\t');
    const [mode, , sha] = rec.slice(0, tab).split(' ');
    return { path: rec.slice(tab + 1), mode, sha: mode === MODE_GITLINK ? '' : sha };
  });
}

/** `<mode> <sha> <stage>\t<path>` records from `git ls-files -s`. */
function parseLsFiles(out: string): Entry[] {
  return splitZ(out).map((rec) => {
    const tab = rec.indexOf('\t');
    const [mode, sha] = rec.slice(0, tab).split(' ');
    return { path: rec.slice(tab + 1), mode, sha: mode === MODE_GITLINK ? '' : sha };
  });
}

/**
 * Look paths up in a tree or in the index, in chunks.
 *
 * Chunked because a large PR can exceed the argv limit, and a gate that dies of
 * E2BIG is a gate that stops running. The chunk size is deliberately modest:
 * this is not a hot path.
 */
function lookup(paths: string[], make: (chunk: string[]) => string[], parse: (out: string) => Entry[]): Entry[] {
  const found: Entry[] = [];
  for (let i = 0; i < paths.length; i += 200) {
    found.push(...parse(git(make(paths.slice(i, i + 200)))));
  }
  return found;
}

/**
 * The files in scope, each bound to the git object that IS its content.
 *
 * A path the diff lists but the tree does not hold is not silently dropped: it
 * comes back with an empty sha and becomes an explicit unscannable finding
 * below. Dropping it would shrink the file set invisibly, which is the exact
 * fail-open this gate exists to prevent.
 */
function entriesFor(mode: string, range?: string): Entry[] {
  if (mode === '--range') {
    if (!range || !range.includes('..')) throw new Error(`--range needs <base>..<head>, got: ${range ?? '(nothing)'}`);
    const head = headOfRange(range);
    const paths = splitZ(git(['diff', '--name-only', '-z', '--diff-filter=ACMR', range]));
    if (paths.length === 0) return [];
    const found = lookup(paths, (c) => ['ls-tree', '-z', '--full-tree', head, '--', ...c], parseLsTree);
    return reconcile(paths, found, `not present in the head tree of ${range}`);
  }
  if (mode === '--staged') {
    const paths = splitZ(git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']));
    if (paths.length === 0) return [];
    const found = lookup(paths, (c) => ['ls-files', '-s', '-z', '--', ...c], parseLsFiles);
    return reconcile(paths, found, 'staged for commit but not present in the index');
  }
  if (mode === '--all') return parseLsFiles(git(['ls-files', '-s', '-z']));
  throw new Error(`unknown mode: ${mode}`);
}

/** Keep the diff's file set exactly, marking anything git could not resolve. */
function reconcile(paths: string[], found: Entry[], missingReason: string): Entry[] {
  const byPath = new Map(found.map((e) => [e.path, e]));
  return paths.map((p) => byPath.get(p) ?? { path: p, mode: '', sha: '' });
}

/**
 * Read every entry's blob in ONE `git cat-file --batch` process.
 *
 * Batched rather than one spawn per file because `--all` runs over the whole
 * repository, and a few thousand process spawns is the difference between a
 * gate that runs on every commit and one people start skipping.
 *
 * Content is decoded latin1 for the same reason the previous implementation
 * did: an embedded ASCII key inside an otherwise binary file is exactly the
 * case worth catching, and latin1 never throws on a byte sequence.
 */
function readAll(entries: Entry[]): ScanInput[] {
  const needsBlob = entries.filter((e) => e.sha);
  const blobs = new Map<string, { content?: string; error?: string }>();

  // Deduped, because two paths can share a blob (identical content, or a file
  // copied) and `--batch` answers ONE record per input line. Reading the stream
  // must therefore consume exactly one record per line SENT, never per path:
  // an early `continue` that skips the parse without advancing the cursor
  // desynchronises everything after it, and the gate then reports one file's
  // content under another file's name. Measured: it attributed nine findings to
  // a 38-line file at lines 69-154.
  const order = [...new Set(needsBlob.map((e) => e.sha))];

  if (order.length) {
    const out = gitBuf(['cat-file', '--batch'], `${order.join('\n')}\n`);
    let at = 0;
    for (const sha of order) {
      const nl = out.indexOf(0x0a, at);
      if (nl < 0) {
        // The stream ended early: every remaining object is unknown, and saying
        // so for each is the fail-closed answer.
        blobs.set(sha, { error: 'git cat-file produced no record for this object' });
        continue;
      }
      const header = out.toString('latin1', at, nl);
      const [, type, sizeText] = header.split(' ');
      if (type !== 'blob') {
        // `missing` and anything non-blob: named, not skipped.
        blobs.set(sha, { error: `git object is ${header.trim()}, not a readable blob` });
        at = nl + 1;
        continue;
      }
      const size = Number(sizeText);
      const start = nl + 1;
      blobs.set(sha, size > MAX_BYTES
        ? { error: `blob is ${(size / 1048576).toFixed(1)} MB, above the ${MAX_BYTES / 1048576} MB scan limit` }
        : { content: out.toString('latin1', start, start + size) });
      at = start + size + 1; // trailing LF after the object body
    }
  }

  return entries.map((e): ScanInput => {
    if (e.mode === MODE_GITLINK) {
      return { path: e.path, unreadable: { reason: 'gitlink (submodule): this repository holds no content for it, so it cannot be cleared here' } };
    }
    if (!e.sha) {
      return { path: e.path, unreadable: { reason: 'git could not resolve this path to a blob' } };
    }
    const b = blobs.get(e.sha);
    if (!b || b.error) return { path: e.path, unreadable: { reason: b?.error ?? 'no object content returned' } };
    return { path: e.path, content: b.content };
  });
}

function report(result: GateResult, mode: string, entries: Entry[]): void {
  const line = (s = '') => process.stdout.write(`${s}\n`);
  line();
  line(`secret-gate (EVIDGUARD818) -- mode ${mode}, ${result.scannedCount} file(s) in scope, read from git objects`);

  const links = entries.filter((e) => e.mode === MODE_SYMLINK);
  if (links.length) {
    line();
    line(`Symlinks (${links.length}) scanned as the blob git stores -- the target path as text, not the file it points at:`);
    for (const l of links) line(`  - ${l.path}`);
  }

  if (result.exceptions.length) {
    line();
    line(`Fixture exceptions applied (${result.exceptions.length}) -- ONE literal each, the rest of the file still scanned:`);
    for (const e of result.exceptions) line(`  - ${e.file}${e.line ? `:${e.line}` : ''}  [${e.detector}]  <- ${e.reason}`);
  }

  if (result.allowlisted.length) {
    line();
    line('Allowlisted by path (NOT scanned, on purpose):');
    for (const a of result.allowlisted) line(`  - ${a.file}  <- ${a.reason}`);
  }

  if (result.ok) {
    line();
    line(`PASS: no denied path, no secret shape, no channel material in ${result.scannedCount} file(s).`);
    return;
  }

  const blocked = result.findings.filter((f) => f.severity === 'blocked');
  const unscannable = result.findings.filter((f) => f.severity === 'unscannable');

  if (blocked.length) {
    line();
    line(`BLOCKED (${blocked.length}):`);
    for (const f of blocked) line(`  ${f.file}${f.line ? `:${f.line}` : ''}  [${f.detector}]  ${f.reason}`);
  }
  if (unscannable.length) {
    line();
    line(`NOT SCANNED, therefore NOT CLEARED (${unscannable.length}):`);
    for (const f of unscannable) line(`  ${f.file}  ${f.reason}`);
  }
  line();
  line('The matched text is deliberately not printed: echoing a secret into CI logs');
  line('would leak it a second time. Look at the file and line above.');
  line();
  line('If a hit is an intentional fixture, add the PATH to ALLOWLISTED_PATHS in');
  line('src/security/secret-gate.ts. Do NOT loosen the pattern: a pattern exception');
  line('opens the same hole in every file in the repository.');
  if (entries.length !== result.scannedCount) {
    line();
    line(`NOTE: ${entries.length} file(s) were listed but ${result.scannedCount} reached the scanner.`);
  }
}

function main(): void {
  const [, , mode = '--staged', range] = process.argv;
  let entries: Entry[];
  try {
    entries = entriesFor(mode, range);
  } catch (e) {
    // Fail-closed: if we cannot even determine the set, we do not pass it.
    process.stdout.write(`\nsecret-gate: FAILED to determine the file set: ${(e as Error).message}\n`);
    process.stdout.write('Fail-closed by design (EVIDGUARD818): an undeterminable set is a failure, not a pass.\n');
    process.exit(2);
  }

  // --staged with nothing staged is a no-op commit, which git blocks anyway;
  // any other mode with an empty set means the computation broke.
  if (entries.length === 0 && mode === '--staged') {
    process.stdout.write('\nsecret-gate: nothing staged, nothing to check.\n');
    process.exit(0);
  }

  const result = runGate(readAll(entries));
  report(result, mode, entries);
  process.exit(result.ok ? 0 : 1);
}

main();
