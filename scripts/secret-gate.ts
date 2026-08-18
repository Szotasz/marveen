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
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { runGate, type ScanInput, type GateResult } from '../src/security/secret-gate.js';

/** Beyond this the file is not scanned -- and therefore not cleared. */
const MAX_BYTES = 5 * 1024 * 1024;

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function fileList(mode: string, range?: string): string[] {
  if (mode === '--staged') {
    return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split('\n').filter(Boolean);
  }
  if (mode === '--range') {
    if (!range || !range.includes('..')) throw new Error(`--range needs <base>..<head>, got: ${range ?? '(nothing)'}`);
    return git(['diff', '--name-only', '--diff-filter=ACMR', range]).split('\n').filter(Boolean);
  }
  if (mode === '--all') return git(['ls-files']).split('\n').filter(Boolean);
  throw new Error(`unknown mode: ${mode}`);
}

/** Binary sniff: a NUL byte in the first 8k. Binary files are still scanned as
 *  latin1 text -- an embedded ASCII key is exactly the case we care about. */
function readForScan(path: string): ScanInput {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (e) {
    return { path, unreadable: { reason: `stat failed (${(e as Error).message})` } };
  }
  if (size > MAX_BYTES) {
    return { path, unreadable: { reason: `file is ${(size / 1048576).toFixed(1)} MB, above the ${MAX_BYTES / 1048576} MB scan limit` } };
  }
  try {
    return { path, content: readFileSync(path, 'latin1') };
  } catch (e) {
    return { path, unreadable: { reason: `read failed (${(e as Error).message})` } };
  }
}

function report(result: GateResult, mode: string, files: string[]): void {
  const line = (s = '') => process.stdout.write(`${s}\n`);
  line();
  line(`secret-gate (EVIDGUARD818) -- mode ${mode}, ${result.scannedCount} file(s) in scope`);

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
  if (files.length !== result.scannedCount) {
    line();
    line(`NOTE: ${files.length} file(s) were listed but ${result.scannedCount} reached the scanner.`);
  }
}

function main(): void {
  const [, , mode = '--staged', range] = process.argv;
  let files: string[];
  try {
    files = fileList(mode, range);
  } catch (e) {
    // Fail-closed: if we cannot even determine the set, we do not pass it.
    process.stdout.write(`\nsecret-gate: FAILED to determine the file set: ${(e as Error).message}\n`);
    process.stdout.write('Fail-closed by design (EVIDGUARD818): an undeterminable set is a failure, not a pass.\n');
    process.exit(2);
  }

  // --staged with nothing staged is a no-op commit, which git blocks anyway;
  // any other mode with an empty set means the computation broke.
  if (files.length === 0 && mode === '--staged') {
    process.stdout.write('\nsecret-gate: nothing staged, nothing to check.\n');
    process.exit(0);
  }

  const result = runGate(files.map(readForScan));
  report(result, mode, files);
  process.exit(result.ok ? 0 : 1);
}

main();
