/**
 * Personal-data gate: the pure core. Which ADDED text carries data about a person
 * (or their machine) that must not leave this host in a public push.
 *
 * The secret gate (secret-gate.ts) asks "is there a CREDENTIAL in this file?".
 * This one asks a different question of a different object: "is there a PERSON in
 * the lines this push adds?". Two questions, one dispatcher, one runner
 * (`scripts/secret-gate.ts --pushed`), because a second parallel gate is a second
 * thing to forget to install.
 *
 * WHY ADDED LINES, NOT FILES. The secret gate reads whole files from the git
 * object store, which is right for a credential: it is wrong wherever it sits.
 * Personal data is different. A file may carry legacy data nobody is touching, and
 * a gate that fails every edit of that file trains people to bypass it. What this
 * push NEWLY publishes is the diff's `+` lines, and nothing else. Deleted lines
 * and context lines are never scanned (a removal of personal data must not be
 * punished: that is the repair).
 *
 * WHY PER COMMIT, NOT ONE NET DIFF. A line added in commit A and removed in commit
 * B is absent from the net diff and PRESENT in the pushed history. The remote
 * receives both commits. The unit of publication is the commit.
 *
 * What it deliberately does NOT do:
 *  - It does not try to recognise a NAME. A name is not a shape. Known names go in
 *    a LOCAL, untracked denylist (see `parseDenylist`): writing the names into
 *    this file would publish them in order to protect them.
 *  - It does not print the matched text. A finding names file, line and detector;
 *    echoing the value into a log would leak it a second time.
 */

import { createHash } from 'node:crypto';

export type PiiDetector =
  | 'email'
  | 'local-path'
  | 'phone'
  | 'iban'
  | 'hu-account'
  | 'hu-taxid'
  | 'denylist'
  | 'binary';

export interface PiiFinding {
  /** Repo path for a diff line, or `commit message` for message text. */
  file: string;
  /** 1-based line in the NEW file (diff) or in the message. */
  line?: number;
  detector: PiiDetector;
  /** Short commit id the text was added in. */
  commit?: string;
  /** Human-readable reason. NEVER contains the matched text. */
  reason: string;
}

/** One added line, as the diff parser hands it over. */
export interface AddedLine {
  file: string;
  line: number;
  text: string;
}

// ── Detectors ───────────────────────────────────────────────────────────────

const EMAIL_RE = /(?<!:\/\/(?:[^\s/@]*:)?)(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Domains that cannot belong to a person: RFC 2606 / 6761 reserved names. */
const RESERVED_DOMAIN =
  /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost|local|internal|lan)$/i;

/** Hosts that publish a no-reply identity by design (GitHub's own forms). */
const NOREPLY_HOST = /(^|\.)noreply\.github\.com$/i;

/** A mailbox that is a machine, not a person. */
const MACHINE_LOCAL = /^(no-?reply|do-?not-?reply|bot)([._+-].*)?$|\[bot\]/i;

/**
 * Local parts of a ROLE mailbox: published by a business so that anyone can write to
 * it. Not data about a person, and the repository's own docs name several (the
 * 2026-09-25 inventory, item 13, left them on purpose). `git` is the user of every
 * SSH remote (`git@github.com:o/r`), which has the shape of an address and is not one.
 */
const ROLE_LOCAL = new Set([
  'support', 'info', 'hello', 'contact', 'admin', 'sales', 'help', 'office', 'team',
  'security', 'abuse', 'postmaster', 'webmaster', 'hr', 'billing', 'noc', 'root',
  'kapcsolat', 'iroda', 'notifications', 'notification', 'alerts', 'mailer-daemon',
  'git', 'ssh',
]);

/** Local parts that are placeholders in every language of the repo (`example@gmail.com`). */
const SYNTHETIC_LOCAL = new Set([
  'example', 'test', 'tester', 'user', 'username', 'name', 'you', 'yourname', 'someone',
  'foo', 'bar', 'demo', 'sample', 'email', 'mail', 'me', 'a', 'b', 'x', 'john.doe',
  'jane.doe', 'jdoe', 'valaki', 'nev', 'pelda',
]);

/**
 * Domains that are synthetic BY FORM or by an explicit word, so a test fixture can say
 * "some company" without being flagged. Measured on the last 150 develop commits:
 * of 504 address hits, ~85% sat on domains like b.hu, x.hu, pelda.hu, ceg.hu --
 * a gate that blocks those is a gate people turn off. Each word here is a claim
 * "this is not a real organisation", and it is reviewed like any other line.
 */
const SYNTHETIC_DOMAIN_WORDS = new Set([
  'pelda', 'peldadomain', 'pelda-domain', 'example', 'examples', 'sample', 'demo',
  'test', 'tester', 'dummy', 'fake', 'placeholder', 'ceg', 'cegnev', 'customer',
  'ugyfel', 'company', 'corp', 'domain', 'yourdomain', 'your', 'mydomain',
  'mycompany', 'evil', 'attacker', 'acme', 'foo', 'bar', 'baz', 'masik', 'uj', 'cim',
]);

/** Addresses that belong to systems (service accounts, calendars, message ids). */
const SYSTEM_DOMAIN = /(^|\.)(gserviceaccount\.com|group\.calendar\.google\.com|mail\.gmail\.com|googlegroups\.com)$/i;

/** Second-level public suffixes: `yahoo.co.uk` registers under `co.uk`, so its label is `yahoo`. */
const SECOND_LEVEL_SUFFIX = /^(co|com|org|net|ac|gov|edu|ne|or|go|gob|nom)$/;

/** The label a person or company actually registered. `mail.ceg.hu` -> `ceg`; `yahoo.co.uk` -> `yahoo`. */
export function registrableLabel(domain: string): string {
  const labels = domain.toLowerCase().split('.');
  if (labels.length < 2) return labels[0] ?? '';
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  if (labels.length >= 3 && tld.length === 2 && SECOND_LEVEL_SUFFIX.test(sld)) return labels[labels.length - 3];
  return sld;
}

/** Two-letter labels that are real mail domains (me.com, wp.pl, qq.com): never placeholders. */
const PLACEHOLDER_TWO_LETTER = new Set(['xx', 'yy', 'zz', 'aa', 'bb', 'cc', 'dd', 'ab', 'cd', 'xy']);

/**
 * Free-mail providers. A placeholder LOCAL part (`example@`, `user@`) is only a
 * placeholder on a provider that nobody owns; on a custom domain (a person's own name
 * as the domain)
 * the domain itself names the person, so the local part excuses nothing.
 */
const FREEMAIL_REGISTRABLE = new Set([
  'gmail', 'googlemail', 'outlook', 'hotmail', 'live', 'msn', 'yahoo', 'ymail', 'icloud',
  'me', 'mac', 'aol', 'proton', 'protonmail', 'pm', 'gmx', 'web', 'wp', 'o2', 'onet',
  'interia', 'freemail', 'citromail', 'indamail', 't-online', 'zoho', 'mail', 'yandex',
  'qq', '163', '126', 'naver', 'seznam', 'tutanota', 'fastmail', 'hey',
]);

function syntheticDomain(domain: string): boolean {
  // The WORDS and the length rule are judged on the REGISTRABLE label only. Judged on any
  // label, an address on a company domain passed because one SUBDOMAIN happened to be called `corp`.
  const registrable = registrableLabel(domain);
  // One letter + `.hu` is how this repository writes "some company" (b.hu, x.hu, d.hu). A
  // one-letter label under any other TLD can be a real domain (x.com, q.com): flag it.
  if (registrable.length === 1 && domain.toLowerCase().endsWith('.hu')) return true;
  if (registrable.length === 2 && PLACEHOLDER_TWO_LETTER.has(registrable)) return true;
  return SYNTHETIC_DOMAIN_WORDS.has(registrable);
}

// Separator: a plain slash or the JSON-escaped `\/`. Leading guard: not in the middle of a word,
// except right after a WSL drive mount (`/mnt/c/Users/...`, this very machine's usual shape).
// Case-insensitive: Windows folders are (`C:\users\name`), and `Users`/`users` are the same place.
const UNIX_HOME_RE = /(?:(?<![A-Za-z0-9_.-])|(?<=\/mnt\/[a-z]))\\?\/(?:home|users)\\?\/([A-Za-z0-9][A-Za-z0-9._-]*)/gi;
const WIN_HOME_RE = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]+users[\\/]+([A-Za-z0-9][A-Za-z0-9._ -]*)/gi;

/**
 * Account names that are placeholders, not people. Lower-case compare. This list
 * is for names that are universally synthetic: anything else under /home or
 * /Users is somebody's machine, and the answer is to make it synthetic, not to
 * grow this list.
 */
const SYNTHETIC_USERS = new Set([
  'u', 'user', 'users', 'username', 'you', 'me', 'name', 'foo', 'bar', 'baz',
  'example', 'test', 'tester', 'dev', 'developer', 'runner', 'ubuntu', 'debian',
  'node', 'app', 'agent', 'deploy', 'docker', 'vscode', 'codespace', 'git',
  'root', 'admin', 'myuser', 'someone', 'alice', 'bob', 'shared', 'guest',
  'public', 'default', 'owner', 'home', 'x', 'xyz', 'abc', 'op', 'operator',
  'old-user', 'testuser', 'test-user', 'test_user', 'john_doe', 'jane_doe', 'jdoe',
  'somebody', 'marveen', 'linuxbrew',
]);

// Separators between digit groups: space ( ) . / - -- Hungarian numbers are written with any of
// them, mixed (spaces, brackets, slashes, dots, dashes), and a pattern that knows only some of
// the spellings is a pattern with a hole in it. The spellings are pinned in the tests.
const PH_SEP = '[\\s().\\/-]*';
const PHONE_RES: RegExp[] = [
  new RegExp(`(?<![\\d+])(?:\\+|00)36${PH_SEP}(?:\\d${PH_SEP}){7,8}\\d(?!\\d)`, 'g'),
  new RegExp(`(?<![\\d+])06${PH_SEP}(?:\\d${PH_SEP}){7,8}\\d(?!\\d)`, 'g'),
  new RegExp(`(?<![\\d+])\\+\\d{1,3}[\\s./-]\\d{1,4}[\\s./-]\\d{3,4}[\\s./-]\\d{3,4}(?!\\d)`, 'g'),
];

const IBAN_RE = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: [A-Z0-9]{1,5}){2,9}(?![A-Za-z0-9])|(?<![A-Za-z0-9])[A-Z]{2}\d{2}[A-Z0-9]{11,30}(?![A-Za-z0-9])/g;
const HU_ACCOUNT_RE = /(?<![\d-])\d{8}-\d{8}(?:-\d{8})?(?![\d-])/g;
const HU_TAXID_RE = /(?<![\d-])\d{8}-[1-5]-\d{2}(?![\d-])/g;

/**
 * Shapes that are digits-with-separators but not a phone number: a date range
 * (`06-26 / 2026-07`, a 4-digit group that is a plausible year) and a counting sequence
 * (`06 07 08 09 10`, every group one or two digits). Found by running the new separator set
 * over the last 150 develop commits.
 */
function notAPhone(text: string): boolean {
  const groups = text.match(/\d+/g) ?? [];
  // A date range: a year-like group and EVERY other group one or two digits long
  // (`06-26 / 2026-07`). A real number keeps a three-digit group next to a four-digit one
  // (`... 987 2024`), so a subscriber number that happens to end in 20xx is still a number.
  // The first version excused ANY 20xx group and let those numbers through (Sam, KOZEPES 3).
  const yearLike = groups.filter((g) => /^20[12]\d$/.test(g));
  if (yearLike.length === 1 && groups.length >= 3 && groups.filter((g) => g !== yearLike[0]).every((g) => g.length <= 2)) return true;
  if (groups.length >= 4 && groups.every((g) => g.length <= 2)) return true;
  return false;
}

function digitsOf(s: string): string {
  return s.replace(/\D/g, '');
}

/** All-one-digit or ascending runs are what a human types as a "fake" number. */
function looksInvented(digits: string, zeroRun = false): boolean {
  if (/^(\d)\1+$/.test(digits)) return true;
  if (digits.includes('1234567')) return true;
  if (digits.includes('5550')) return true;
  // A long zero run is a placeholder subscriber number -- but NOT in a bank account,
  // where the third block of the 8-8-8 form is routinely 00000000.
  if (zeroRun && /0{5,}/.test(digits)) return true;
  return false;
}

/** ISO 13616 mod-97. Cheap, and it cuts the false positives of the IBAN shape to ~none. */
export function ibanChecksumOk(raw: string): boolean {
  const s = raw.replace(/ /g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

export function emailIsPerson(addr: string): boolean {
  const at = addr.lastIndexOf('@');
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  if (RESERVED_DOMAIN.test(domain)) return false;
  if (NOREPLY_HOST.test(domain)) return false;
  if (SYSTEM_DOMAIN.test(domain)) return false;
  if (MACHINE_LOCAL.test(local)) return false;
  if (ROLE_LOCAL.has(local.toLowerCase())) return false;
  if (SYNTHETIC_LOCAL.has(local.toLowerCase()) && FREEMAIL_REGISTRABLE.has(registrableLabel(domain))) return false;
  if (syntheticDomain(domain)) return false;
  return true;
}

export interface RawHit {
  detector: PiiDetector;
  /** The matched text. Used to look up an exception by hash; never printed. */
  matched: string;
  reason: string;
}

/** Every personal-data shape in one piece of added text. */
export function detect(text: string, opts: { skipEmail?: boolean; denylist?: Denylist } = {}): RawHit[] {
  const hits: RawHit[] = [];

  if (!opts.skipEmail) {
    for (const m of text.matchAll(EMAIL_RE)) {
      if (emailIsPerson(m[0])) {
        hits.push({ detector: 'email', matched: m[0], reason: 'an e-mail address that is not a reserved or no-reply form' });
      }
    }
  }

  // `C:/Users/name` is matched by BOTH expressions (the unix one sees `/Users/name`):
  // one account on one line is one finding.
  const seenAccounts = new Set<string>();
  for (const re of [WIN_HOME_RE, UNIX_HOME_RE]) {
    for (const m of text.matchAll(re)) {
      // Trailing punctuation belongs to the SENTENCE, not the account: "... /home/u." is
      // the placeholder account `u` at the end of a sentence, not an account named `u.`.
      const user = m[1].replace(/[. -]+$/, '');
      const key = user.toLowerCase();
      if (SYNTHETIC_USERS.has(key) || seenAccounts.has(key)) continue;
      seenAccounts.add(key);
      hits.push({ detector: 'local-path', matched: m[0], reason: 'a home-directory path with a real-looking account name' });
    }
  }

  // The three phone shapes overlap (a +36 number is also a generic +cc number): a
  // span already reported by one is not reported again by the next.
  const phoneSpans: [number, number][] = [];
  for (const re of PHONE_RES) {
    for (const m of text.matchAll(re)) {
      const a = m.index ?? 0;
      const b = a + m[0].length;
      if (phoneSpans.some(([x, y]) => a < y && b > x)) continue;
      phoneSpans.push([a, b]);
      if (!looksInvented(digitsOf(m[0]), true) && !notAPhone(m[0])) {
        hits.push({ detector: 'phone', matched: m[0], reason: 'a phone-number shape' });
      }
    }
  }

  for (const m of text.matchAll(IBAN_RE)) {
    // A space-grouped match is greedy and may have swallowed the word after the
    // number. Try it whole, then one group shorter, until a checksum holds.
    const groups = m[0].split(' ');
    for (let k = groups.length; k >= 2; k--) {
      const cand = groups.slice(0, k).join(' ');
      if (ibanChecksumOk(cand)) {
        hits.push({ detector: 'iban', matched: cand, reason: 'a valid IBAN (checksum passes)' });
        break;
      }
    }
  }
  for (const m of text.matchAll(HU_ACCOUNT_RE)) {
    if (!looksInvented(digitsOf(m[0]))) {
      hits.push({ detector: 'hu-account', matched: m[0], reason: 'a Hungarian bank-account-number shape (8-8 or 8-8-8)' });
    }
  }
  for (const m of text.matchAll(HU_TAXID_RE)) {
    hits.push({ detector: 'hu-taxid', matched: m[0], reason: 'a Hungarian tax-number shape (8-1-2)' });
  }

  if (opts.denylist) {
    for (const rule of opts.denylist.rules) {
      const m = rule.re.exec(text);
      rule.re.lastIndex = 0;
      if (m) hits.push({ detector: 'denylist', matched: m[0], reason: 'a term on the local denylist' });
    }
  }
  return hits;
}

// ── The local denylist ──────────────────────────────────────────────────────

export interface Denylist {
  rules: { re: RegExp }[];
}

export const EMPTY_DENYLIST: Denylist = Object.freeze({ rules: [] }) as Denylist;

/**
 * Parse the LOCAL denylist (one rule per line; `#` comments; blank lines ignored).
 *   plain text      a case-insensitive literal
 *   re:<pattern>    a case-insensitive regular expression
 *
 * The file lives in the git hooks directory, outside the tree, on purpose: the
 * names it holds are the very data this gate protects, and a tracked denylist
 * would publish them. A line that does not compile THROWS. A denylist that
 * silently drops a rule it could not read is a gate that is weaker than its
 * owner believes, which is the fail-open this file exists to prevent.
 */
export function parseDenylist(text: string): Denylist {
  const rules: { re: RegExp }[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const src = line.startsWith('re:')
      ? line.slice(3)
      : line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      rules.push({ re: new RegExp(src, 'i') });
    } catch (e) {
      throw new Error(`denylist line ${i + 1} is not a valid rule: ${(e as Error).message}`);
    }
  });
  return { rules };
}

// ── Exceptions ──────────────────────────────────────────────────────────────

/**
 * One literal, in one file, with a written reason. Same design as the secret
 * gate's FIXTURE_EXCEPTIONS and for the same three reasons: the key is a HASH of
 * the matched text (a line number goes stale, and the literal itself cannot live
 * in the scanner), a changed literal makes the exception stop applying (fail
 * closed), and every applied exception is REPORTED so somebody keeps re-reading it.
 */
export interface PiiException {
  path: string;
  /** sha256 (hex, utf-8 bytes) of the EXACT text a detector matched. */
  sha256: string;
  reason: string;
}

export const PII_EXCEPTIONS: readonly PiiException[] = Object.freeze([]);

export function piiHash(matched: string): string {
  return createHash('sha256').update(matched, 'utf8').digest('hex');
}

export function invalidPiiExceptions(
  list: readonly PiiException[] = PII_EXCEPTIONS,
): { path: string; reason: string }[] {
  const seen = new Set<string>();
  const bad: { path: string; reason: string }[] = [];
  for (const e of list) {
    const key = `${e.path}#${e.sha256}`;
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) bad.push({ path: e.path, reason: 'sha256 must be 64 lowercase hex characters' });
    if (!e.reason || e.reason.trim().length < 20) bad.push({ path: e.path, reason: 'an exception without a real written reason is a hole nobody can review' });
    if (seen.has(key)) bad.push({ path: e.path, reason: 'duplicate exception entry' });
    seen.add(key);
  }
  return bad;
}

export function piiExceptionReason(
  path: string, matched: string, list: readonly PiiException[] = PII_EXCEPTIONS,
): string | null {
  const digest = piiHash(matched);
  const hit = list.find((e) => e.path === path && e.sha256 === digest);
  return hit ? hit.reason : null;
}

// ── Scanning ────────────────────────────────────────────────────────────────

export interface PiiScanResult {
  findings: PiiFinding[];
  exceptions: { file: string; line?: number; detector: string; reason: string }[];
}

export interface ScanOptions {
  denylist?: Denylist;
  exceptions?: readonly PiiException[];
  /** Commit trailers (Co-authored-by, ...) carry e-mail addresses by design. */
  messageMode?: boolean;
}

const TRAILER_RE = /^(co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|helped-by)\s*:/i;

export function scanAdded(
  lines: AddedLine[], commit: string | undefined, opts: ScanOptions = {},
): PiiScanResult {
  const findings: PiiFinding[] = [];
  const exceptions: PiiScanResult['exceptions'] = [];
  for (const l of lines) {
    const skipEmail = opts.messageMode === true && TRAILER_RE.test(l.text.trim());
    for (const h of detect(l.text, { skipEmail, denylist: opts.denylist })) {
      const why = piiExceptionReason(l.file, h.matched, opts.exceptions ?? PII_EXCEPTIONS);
      if (why) {
        exceptions.push({ file: l.file, line: l.line, detector: h.detector, reason: why });
        continue;
      }
      findings.push({ file: l.file, line: l.line, detector: h.detector, commit, reason: h.reason });
    }
  }
  return { findings, exceptions };
}

// ── The diff parser ─────────────────────────────────────────────────────────

/**
 * The `+` lines of a `git log -p`/`git show` patch, with their line numbers in
 * the NEW file.
 *
 * Counted by hunk length, never by looking at what a line "looks like". The
 * obvious parser treats a line starting with `+++` as a file header; an ADDED
 * line whose content begins with `++` is then misread as a header and silently
 * dropped, and the gate goes blind on exactly the line an attacker (or a
 * Markdown table) writes. Inside a hunk, the hunk header says how many lines
 * belong to it, and that count is the only authority.
 *
 * Combined diffs (merge commits, `--cc`) have `@@@` hunk headers and one prefix
 * column per parent. A line is NEW only if EVERY column says `+`: anything else
 * exists in one of the parents already and is not published by this commit.
 */
export function parseAddedLines(patch: string): { lines: AddedLine[]; binary: string[] } {
  const out: AddedLine[] = [];
  const binary: string[] = [];
  const rows = patch.split('\n');
  let file = '';
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.startsWith('diff --git ') || row.startsWith('diff --cc ') || row.startsWith('diff --combined ')) {
      file = '';
      i++;
      while (i < rows.length && !rows[i].startsWith('@@') && !rows[i].startsWith('diff ')) {
        const r = rows[i];
        if (r.startsWith('+++ ')) {
          const p = r.slice(4);
          file = p === '/dev/null' ? '' : p.replace(/\t$/, '').replace(/^b\//, '');
        } else if (r.startsWith('Binary files ') || r.startsWith('GIT binary patch')) {
          binary.push(file || r);
        }
        i++;
      }
      continue;
    }
    const hm = /^(@{2,}) ((?:[-+]\d+(?:,\d+)? )+)@{2,}/.exec(row);
    if (hm) {
      const parents = hm[1].length - 1;
      const ranges = hm[2].trim().split(' ');
      const newRange = ranges[ranges.length - 1];
      const nm = /^\+(\d+)(?:,(\d+))?$/.exec(newRange);
      let newLine = nm ? Number(nm[1]) : 0;
      const newLen = nm && nm[2] !== undefined ? Number(nm[2]) : 1;
      const oldLens = ranges.slice(0, -1).map((r) => {
        const m = /^-(\d+)(?:,(\d+))?$/.exec(r);
        return m && m[2] !== undefined ? Number(m[2]) : 1;
      });
      i++;
      // Consume exactly the lines this hunk owns. Column k of the prefix says how
      // the line stands against parent k: ' ' present in both, '-' present only in
      // the parent, '+' present only in the result. So a line is in the RESULT iff
      // no column is '-', and in parent k iff column k is not '+'.
      let newSeen = 0;
      const oldSeen = new Array(parents).fill(0);
      while (i < rows.length) {
        if (newSeen >= newLen && oldSeen.every((s, k) => s >= oldLens[k])) break;
        const r = rows[i];
        if (r.startsWith('\\')) { i++; continue; } // "\ No newline at end of file"
        const prefix = r.slice(0, parents);
        const inResult = ![...prefix].includes('-');
        if (inResult && [...prefix].every((c) => c === '+') && prefix.length === parents) {
          const text = r.slice(parents);
          // The patch is produced with --text, so git never says "Binary files differ": a NUL
          // byte in an added line IS the signal (it is also git's own binary heuristic).
          if (text.includes('\0') && file && !binary.includes(file)) binary.push(file);
          out.push({ file, line: newLine, text });
        }
        if (inResult) { newLine++; newSeen++; }
        [...prefix].forEach((c, k) => { if (c !== '+') oldSeen[k]++; });
        i++;
      }
      continue;
    }
    i++;
  }
  return { lines: out, binary };
}
