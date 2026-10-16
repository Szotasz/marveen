#!/usr/bin/env tsx
/**
 * Secret filter for scripts/pre-pr-review.sh: scans the EXACT diff text that
 * would be sent to an external LLM, line by line, and names file:line plus the
 * detector for every hit. The matched text is never printed.
 *
 *   tsx scripts/pre-pr-review-scan.ts <diff-file>
 *   exit 0 = clean, 1 = findings, 2 = could not scan (treat as a finding)
 *
 * Every line is scanned for content, headers and `@@` lines included: git puts
 * the nearest preceding source line after the `@@` (the "function context"),
 * so an UNCHANGED secret line can ride along there, and a removed line that
 * reads `-- a/...` looks like a file header to a parser that does not count.
 * Header vs hunk state is tracked from the hunk counters only to attribute a
 * line to a file and to apply the path rules to real headers.
 *
 * The secret shapes are the repo gate's own list (src/security/secret-gate.ts
 * SECRET_PATTERNS), so a shape added there is enforced here too. On top of it,
 * because this text LEAVES the machine, three broader rules the gate does not
 * carry (it scans committed files, where they would cry wolf):
 *   - any hex run of 32+ chars (the dashboard token is 64 hex), except a
 *     40-char commit sha in a git context;
 *   - a NUL byte or a `GIT binary patch` block anywhere in the diff: neither
 *     can be scanned as text (a UTF-16 file forced to text diff, a committed
 *     .patch with base85 payload), so either one is a finding;
 *   - a high-entropy token of 32+ chars mixing upper, lower and digits, except
 *     SRI hashes (sha256-/sha384-/sha512-) and URL paths;
 *   - credential file paths in the diff headers.
 */
import { readFileSync } from 'node:fs';
import { SECRET_PATTERNS, DENIED_PATH_PATTERNS } from '../src/security/secret-gate.js';

/** Shapes the gate does not list, kept looser on purpose: this is egress. */
const EXTRA_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'openai/anthropic key (sk-)', pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/ },
  { name: 'google api key (AIza)', pattern: /AIza[0-9A-Za-z_-]{30,}/ },
  { name: 'github fine-grained token', pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'pem block (-----BEGIN)', pattern: /-----BEGIN [A-Z0-9 ]*-----/ },
  { name: 'aws temporary access key id', pattern: /\bASIA[0-9A-Z]{16}\b/ },
  { name: 'gitlab token', pattern: /glpat-[A-Za-z0-9_-]{20,}/ },
];
const CONTENT_PATTERNS = [...SECRET_PATTERNS, ...EXTRA_PATTERNS];

const HEX_RUN = /[0-9a-fA-F]{32,}/g;
/** What may precede a 40-char commit sha for it to count as one. */
const GIT_CONTEXT = /(?:\b(?:commit|commits|sha1?|rev|revision|parent|merge|tree|blob|ref|index|HEAD|cherry-picked from)\b[^A-Za-z0-9\n]{0,4}|[#@])$/i;
const BINARY_PATCH = /^[-+ ]?(?:GIT binary patch|(?:literal|delta) \d+)\s*$/;
const TOKEN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
const SRI = /^sha(?:256|384|512)-/;
const CRED_NAMES = new RegExp(
  '(^|/)(\\.env(\\.[^/]*)?|\\.netrc|\\.npmrc|\\.pypirc|\\.dashboard-token|\\.claude-oauth-token'
  + '|\\.?credentials(\\.json)?|id_(rsa|dsa|ecdsa|ed25519)|service-account[^/]*\\.json'
  + '|[^/]+\\.(pem|key|p12|pfx|jks|keystore|token))$');
const ENV_TEMPLATES = /(^|\/)\.env\.(example|sample|template|dist)$/;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) h -= (c / s.length) * Math.log2(c / s.length);
  return h;
}

function hexFinding(line: string): boolean {
  for (const m of line.matchAll(HEX_RUN)) {
    const run = m[0];
    if (!/[0-9]/.test(run) || !/[a-fA-F]/.test(run)) continue;
    if (run.length === 40 && GIT_CONTEXT.test(line.slice(Math.max(0, m.index! - 40), m.index))) continue;
    return true;
  }
  return false;
}

function entropyFinding(line: string): boolean {
  for (const m of line.matchAll(TOKEN)) {
    const tok = m[0];
    if (SRI.test(tok)) continue;
    // A URL path (github.com/Owner/repo...) is not a key.
    if (tok.includes('/') && ['.', ':'].includes(line.slice(Math.max(0, m.index! - 1), m.index))) continue;
    // Random key material of this length mixes all three classes; plain
    // paths and CONSTANT_NAMES do not.
    if (!(/[0-9]/.test(tok) && /[a-z]/.test(tok) && /[A-Z]/.test(tok))) continue;
    if (entropy(tok) > 4.2) return true;
  }
  return false;
}

/** All findings for one diff text, as `<where>: <detector>` lines. */
export function scanDiff(text: string): string[] {
  const findings: string[] = [];
  // UTF-16 and other NUL-carrying text hides every pattern between its bytes.
  if (text.includes('\0')) findings.push('(whole diff): NUL byte in the diff (binary or UTF-16 content, cannot be scanned)');
  const pathFinding = (raw: string) => {
    let p = raw.trim();
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    p = p.replace(/^[ab]\//, '');
    if (!p || p === '/dev/null') return;
    if (CRED_NAMES.test(p) && !ENV_TEMPLATES.test(p)) findings.push(`${p}: credential file path in the diff`);
    for (const { pattern, reason } of DENIED_PATH_PATTERNS) {
      if (pattern.test(p)) { findings.push(`${p}: denied path (${reason})`); break; }
    }
  };

  let file = '(diff header)';
  let oldLeft = 0, newLeft = 0, oldNo = 0, newNo = 0;
  for (const line of text.split('\n')) {
    let where: string;
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (inHunk && line.startsWith('-')) {
      where = `${file}:${oldNo} (removed line)`; oldNo++; oldLeft--;
    } else if (inHunk && line.startsWith('+')) {
      where = `${file}:${newNo}`; newNo++; newLeft--;
    } else if (inHunk && (line.startsWith(' ') || line === '')) {
      where = `${file}:${newNo} (context)`; oldNo++; newNo++; oldLeft--; newLeft--;
    } else if (inHunk && line.startsWith('\\')) {
      where = `${file} (diff metadata)`;
    } else {
      // Header state.
      oldLeft = 0; newLeft = 0;
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        oldNo = Number(hunk[1]); oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
        newNo = Number(hunk[3]); newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
        where = `${file}:${newNo} (hunk header)`;
      } else if (line.startsWith('diff --git ')) {
        const rest = line.slice('diff --git '.length);
        const cut = rest.lastIndexOf(' b/');
        if (cut > 0) { pathFinding(rest.slice(0, cut)); pathFinding(rest.slice(cut + 1)); file = rest.slice(cut + 3); } else pathFinding(rest);
        where = `${file} (diff header)`;
      } else {
        const head = /^(?:--- |\+\+\+ |rename from |rename to |copy from |copy to )(.*)$/.exec(line);
        if (head) {
          pathFinding(head[1]);
          if (line.startsWith('+++ ') && head[1].trim() !== '/dev/null') file = head[1].trim().replace(/^"?b\//, '').replace(/"$/, '');
        }
        where = `${file} (diff header)`;
      }
    }
    // Base85 payload, in a real binary hunk or inside a committed .patch file.
    if (BINARY_PATCH.test(line)) findings.push(`${where}: binary patch block (base85, cannot be scanned)`);
    // Content rules on EVERY line, whatever the parser thinks it is.
    for (const { name, pattern } of CONTENT_PATTERNS) {
      if (pattern.test(line)) findings.push(`${where}: secret shape: ${name}`);
    }
    if (hexFinding(line)) findings.push(`${where}: hex run of 32+ chars`);
    if (entropyFinding(line)) findings.push(`${where}: high-entropy token (>= 32 chars)`);
  }
  return [...new Set(findings)];
}

function main(): void {
  const path = process.argv[2];
  let text: string;
  try {
    if (!path) throw new Error('usage: pre-pr-review-scan.ts <diff-file>');
    text = readFileSync(path, 'latin1');
  } catch (e) {
    process.stdout.write(`could not scan the diff: ${(e as Error).message}\n`);
    process.exit(2);
  }
  const findings = scanDiff(text);
  for (const f of findings) process.stdout.write(`${f}\n`);
  process.exit(findings.length ? 1 : 0);
}

main();
