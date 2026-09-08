/**
 * EVIDGUARD818: the secret gate's pure core.
 *
 * Why it exists: on 2026-07-22 an ElevenLabs API key reached this PUBLIC repo in
 * commit 48638cb6. It was not written into code -- it sat inside a QUOTED
 * TELEGRAM MESSAGE in our own `.pre-ship-evidence` artifact. Nothing looked at
 * that file, because nothing looked at anything. The key is dead and that case
 * is closed; this module closes the mechanism.
 *
 * Three detectors, because any one of them alone would have missed it:
 *   1. PATH      -- evidence/artifact directories have no business in the repo.
 *   2. CONTENT   -- known secret shapes (sk_live_, private keys, JWTs, ...).
 *   3. TRANSCRIPT-- channel material (message_id NNN: "...") regardless of what
 *                   it quotes. This is the one that would have caught the 2026-07
 *                   leak even though nobody had listed the ElevenLabs key format.
 *
 * FAIL-CLOSED is the rule, not a mode: an empty file set, an unreadable file, a
 * file too large to scan -- each is a FAILURE with a named reason, never a pass.
 * A silent skip reads as "scanned and clean", which is the failure mode that let
 * the original leak through.
 */

import { createHash } from 'node:crypto';

export type Severity = 'blocked' | 'unscannable';

export interface Finding {
  file: string;
  detector: 'path' | 'content' | 'transcript' | 'unscannable';
  severity: Severity;
  /** 1-based line, when the detector found a location. */
  line?: number;
  /** Human-readable reason. NEVER contains the matched secret itself. */
  reason: string;
}

export interface ScanInput {
  path: string;
  /** File bytes. Undefined when the file could not be read at all. */
  content?: string;
  /** Set when the caller could not fully read the file (size, binary, timeout). */
  unreadable?: { reason: string };
}

export interface GateResult {
  ok: boolean;
  findings: Finding[];
  scannedCount: number;
  /** Files the gate deliberately let through, with the reason. Always reported. */
  allowlisted: { file: string; reason: string }[];
  /** Single literals cleared by a fixture exception. Always reported: an
   *  exception nobody sees is an exception nobody re-reads. */
  exceptions: { file: string; line?: number; detector: string; reason: string }[];
}

/**
 * Directories whose whole point is to hold captured output: pre-ship evidence,
 * run artifacts, transcripts. Nothing in here is reviewed line by line, which is
 * exactly why a secret inside one survives review.
 */
export const DENIED_PATH_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|\/)\.pre-ship-evidence(\/|$)/, reason: 'pre-ship evidence directory (EVIDGUARD818: this is where the 2026-07 key leaked)' },
  { pattern: /(^|\/)evidence(\/|$)/, reason: 'evidence directory' },
  { pattern: /(^|\/)\.evidence(\/|$)/, reason: 'evidence directory' },
  { pattern: /(^|\/)transcripts?(\/|$)/, reason: 'transcript directory' },
  { pattern: /(^|\/)\.session-capture(\/|$)/, reason: 'session capture directory' },
  { pattern: /\.pre-ship-evidence[^/]*$/, reason: 'pre-ship evidence file' },
];

/**
 * Content shapes. Kept deliberately anchored: measured against this repo on
 * 2026-08-18, a bare `sk_` matches `task_name` and `skipIfBusy`, and a bare
 * `Bearer ` matches 64 files of `Bearer ${token}`. A gate that cries wolf gets
 * bypassed, and a bypassed gate protects nothing.
 */
export const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Stripe secret/restricted key', pattern: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/ },
  { name: 'ElevenLabs key header', pattern: /xi-api-key["'\s:=]+[A-Za-z0-9_-]{16,}/i },
  { name: 'ElevenLabs key literal', pattern: /\bsk_[a-f0-9]{32,}/ },
  { name: 'bearer token literal', pattern: /\bBearer\s+[A-Za-z0-9_-]{24,}\.?[A-Za-z0-9_.-]*/ },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'OpenAI project key', pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}/ },
  // BOTH separators, on purpose. Boni's first detector looked for `sk-` only
  // and returned zero on a key that used `sk_` -- and zero looks reassuring.
  // No upper length bound either: the leaked key was 51 chars, a rule written
  // around "32 hex" would have missed it.
  { name: 'generic vendor secret key (sk_ or sk-)', pattern: /\bsk[-_][A-Za-z0-9_-]{24,}/ },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Supabase service_role JWT hint', pattern: /service_role["'\s:=]+eyJ/ },
];

/**
 * Channel material. The 2026-07 leak was a pasted Telegram message; the secret
 * inside it was incidental. Quoted channel traffic does not belong in the repo
 * whatever it happens to contain, so this detector does not look at the payload.
 */
export const TRANSCRIPT_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'quoted channel message', pattern: /\bmessage_id\s*[:=]?\s*\d{2,}\s*[:\-]/ },
  { name: 'telegram update dump', pattern: /"(update_id|from_user|chat_id)"\s*:\s*\d+/ },
  { name: 'quoted agent transcript header', pattern: /^\s*\[Uzenet @[a-z0-9_-]+-tol/im },
  // Same trap on the transcript side: this repo's evidence files use
  // `message_id NNN:`, but a wrapper tag is just as much channel material.
  // One form only would give a clean zero on the other.

];

/**
 * Paths that MAY carry a matching pattern on purpose. Path-based by design:
 * a pattern-level exception would punch the same hole in every file, which is
 * how a real leak walks through a gate that was meant to allow a fixture.
 *
 * Seeded from measurement (2026-08-18), not from memory: these are the tracked
 * files that legitimately contain token-shaped fixtures today.
 *
 * This file is deliberately NOT on the list. Measured: the detectors are regex
 * LITERALS, and the character class breaks the pattern against its own source
 * (after `sk-proj-` the text has `[`, which the class does not accept), so the
 * gate passes over itself with 757/757. An exemption here would be the one
 * place a real secret could be pasted and cleared, and `secret-gate.test.ts`
 * pins that the exemption stays absent.
 */
export const ALLOWLISTED_PATHS: { path: string; reason: string }[] = [
  { path: 'src/__tests__/auth-device-keys.test.ts', reason: 'device-key auth test: synthetic Bearer fixtures' },
  { path: 'src/__tests__/auth-gate.test.ts', reason: 'auth gate test: synthetic Bearer fixtures' },
  { path: 'src/__tests__/secret-gate.test.ts', reason: 'the gate\'s own tests: synthetic secrets are the subject under test' },
  { path: 'src/__tests__/channel-inbound-framing.test.ts', reason: 'channel framing test: synthetic wrapper frames with sample ids are the subject under test' },
  { path: 'scripts/__tests__/conversation-ledger.test.sh', reason: 'ledger test: synthetic wrapper frames with sample ids' },
  { path: 'src/__tests__/agent-terminal-mask-keys.test.ts', reason: 'terminal masking test: a hand-written sk-ant- shaped fixture IS the input under test -- the assertion is that no fragment of it reaches the audit line, so a different shape would stop measuring the thing' },
  // MIOCLISKILL831 -- a `marveen skill` szkennerenek fixture-jei. A fajl
  // TARGYA egy kulcs-alaku string: a mio-scan `api-key-shaped` szabalyanak
  // kell valamin tuznie, es az aranyfajl ugyanazt a szoveget tartalmazza,
  // mert az EREDETI Python szkenner kimenete.
  //
  // A LISTA MERESBOL JON, NEM A CI ELSO HIBAJABOL: lefuttattam a gate-et a
  // TELJES fixture-mappara (`--all`, 896 fajl), es PONTOSAN ez a ket fajl
  // akad fenn. A tobbi szandekos fixture (13-card-shaped, 16-hu-taj,
  // 17-secret-assignment) MAS alakot hordoz, amit ez a gate nem is keres --
  // azokat ezert NEM vettem fel: egy nem-szukseges bejegyzes csak elvakitana
  // a gate-et olyan fajlokon, amiket ma meg ellenoriz.
  //
  // EGY TOROKENYSEG KIMONDVA: a `15-bearer.md` CSAK HAJSZALLAL nem akad fenn.
  // A `bearer token literal` minta 24 karaktertol figyel, az ottani token 21.
  // Ha az a fixture valaha hosszabb lesz, vagy a kuszob csokken, fel fog
  // akadni -- akkor ide kerul, ugyanezzel az indokkal.
  { path: 'src/__tests__/fixtures/skill-scan/14-api-key-shaped.md', reason: 'skill-scan fixture: an api-key-shaped string is the subject under test' },
  { path: 'src/__tests__/fixtures/skill-scan/14-api-key-shaped.expected.json', reason: 'skill-scan golden output from the original Python scanner: it quotes the fixture above' },
];

/**
 * The wrapper tag ALONE is not evidence: this repo implements channel framing,
 * so `<channel source="...">` legitimately appears in 24 tracked files (code,
 * tests, docs, hook scripts -- measured 2026-08-18). Flagging those would make
 * the gate noise, and a noisy gate gets switched off.
 *
 * Captured material is the tag TOGETHER WITH a payload marker in the same file.
 * That pair narrows 27 files to 3, all of them deliberate test fixtures.
 */
export const WRAPPER_TAG = /<\s*(channel|trusted-peer)\b[^>]*\bsource\s*=\s*["'][^"']+["'][^>]*>/i;
export const WRAPPED_PAYLOAD = /\bmessage_id\s*[:=]?\s*\d{2,}|"(update_id|chat_id|from_user)"\s*:\s*\d+/;

/**
 * A fixture exception: ONE secret-shaped literal, in ONE test file, cleared by
 * name, with the rest of the file still scanned.
 *
 * WHY THIS EXISTS ALONGSIDE ALLOWLISTED_PATHS. An allowlist entry blinds a
 * WHOLE FILE. That is the right trade when the file's entire subject is
 * synthetic secrets (the gate's own tests), and the wrong one for an ordinary
 * test file that happens to need one key-shaped literal: from then on nothing
 * in it is checked, including the parts nobody was thinking about.
 *
 * Found on PR #628 (2026-09-06). Two costops collector tests carry an `sk-`
 * shaped fixture, and both literals are load-bearing: one drives the assertion
 * that a RAW secret in `secret_ref` must be rejected in favour of a `vault:`
 * reference, the other drives "the secret never reaches the report". Replacing
 * them with a neutral string would leave the tests passing while measuring
 * something weaker than their names claim. Blinding both whole files to keep
 * two lines is the other bad trade. Hence this: the narrowest exception that
 * still lets the gate do its job.
 *
 * THE KEY IS A HASH OF THE MATCHED TEXT, NOT A LINE NUMBER AND NOT THE LITERAL.
 *  - A line number goes stale the moment anyone edits above it, and a stale
 *    exception either stops working or, worse, starts covering a different line.
 *  - The literal itself cannot live here: this file is scanned too, and writing
 *    a secret shape into the scanner to excuse a secret shape elsewhere is how
 *    the exception becomes the leak.
 *  - A hash is exact and fails closed: change the fixture and the exception
 *    simply stops applying, so the gate goes red and a human looks again.
 */
export interface FixtureException {
  /** Test file the fixture lives in. A non-test path is REFUSED, loudly. */
  path: string;
  /** sha256 (hex, latin1 bytes) of the EXACT text the detector matched. */
  sha256: string;
  /** Why this literal must keep its secret shape. Not optional. */
  reason: string;
}

/** Only these paths may carry a fixture exception. */
const TEST_PATH = /(^|\/)(__tests__|tests)\//;

export const FIXTURE_EXCEPTIONS: readonly FixtureException[] = Object.freeze([
  {
    path: 'src/__tests__/costops-collectors-dryrun.test.ts',
    sha256: '8e11255764528986c15d1063a0bbafc4663de6f1c4e40c5d5e60bd5ff0e99454',
    reason: 'costops collector dry-run: the SECRET constant is asserted NOT to appear in the report, the audit row or the DB dump. A neutral string would still pass while proving less -- the shape is what makes the leak test meaningful.',
  },
  {
    path: 'src/__tests__/costops-collectors.test.ts',
    sha256: 'db8f43c042cf5bdf36abda27c6fb50a1eac827489a10916a552531b93cb548cd',
    reason: 'collectors config validation: this literal IS the input to "rejects a raw secret in secret_ref (must be vault:)". Its raw-secret shape is the subject under test.',
  },
]);

export type ExceptionProblem = { path: string; reason: string };

/** Exceptions that are not allowed to apply, with why. Reported, never silent. */
export function invalidFixtureExceptions(
  list: readonly FixtureException[] = FIXTURE_EXCEPTIONS,
): ExceptionProblem[] {
  const seen = new Set<string>();
  const bad: ExceptionProblem[] = [];
  for (const e of list) {
    const key = `${e.path}#${e.sha256}`;
    if (!TEST_PATH.test(e.path)) {
      bad.push({ path: e.path, reason: 'fixture exceptions are TEST-ONLY, and this path is not under __tests__/ or tests/' });
    }
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) {
      bad.push({ path: e.path, reason: 'sha256 must be 64 lowercase hex characters' });
    }
    if (!e.reason || e.reason.trim().length < 20) {
      bad.push({ path: e.path, reason: 'an exception without a real written reason is a hole nobody can review' });
    }
    if (seen.has(key)) bad.push({ path: e.path, reason: 'duplicate exception entry' });
    seen.add(key);
  }
  return bad;
}

/** The reason this exact matched text is excepted in this exact file, or null.
 *
 *  The list is a parameter so the mechanism can be tested against SYNTHETIC
 *  entries. Testing it only through the real entries would mean writing their
 *  literals into a test file to reproduce the hashes -- putting the very
 *  secret-shaped strings this exists to contain into one more place. */
export function fixtureExceptionReason(
  path: string, matched: string, list: readonly FixtureException[] = FIXTURE_EXCEPTIONS,
): string | null {
  if (!TEST_PATH.test(path)) return null;
  const digest = createHash('sha256').update(matched, 'latin1').digest('hex');
  const hit = list.find((e) => e.path === path && e.sha256 === digest);
  return hit ? hit.reason : null;
}

export function allowlistReason(path: string): string | null {
  const hit = ALLOWLISTED_PATHS.find((a) => a.path === path);
  return hit ? hit.reason : null;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

export interface ScanOutcome {
  findings: Finding[];
  exceptions: { file: string; line?: number; detector: string; reason: string }[];
}

/** All findings for ONE file. An allowlisted path yields none.
 *  Kept for callers that only want the findings. */
export function scanFile(input: ScanInput): Finding[] {
  return scanFileDetailed(input).findings;
}

/** Findings AND the fixture exceptions that were applied, so the caller can
 *  report what was let through rather than quietly not mentioning it. */
export function scanFileDetailed(
  input: ScanInput, list: readonly FixtureException[] = FIXTURE_EXCEPTIONS,
): ScanOutcome {
  const { path } = input;
  const exceptions: ScanOutcome['exceptions'] = [];
  if (allowlistReason(path)) return { findings: [], exceptions };

  const findings: Finding[] = [];

  for (const { pattern, reason } of DENIED_PATH_PATTERNS) {
    if (pattern.test(path)) {
      findings.push({ file: path, detector: 'path', severity: 'blocked', reason });
      break;
    }
  }

  // An unreadable file is a FAILURE, not a skip: "could not scan" must never
  // render as "scanned and clean".
  if (input.unreadable) {
    findings.push({
      file: path,
      detector: 'unscannable',
      severity: 'unscannable',
      reason: `${input.unreadable.reason} -- the gate could not read this file, so it cannot clear it. Allowlist the path if it is intentional.`,
    });
    return { findings, exceptions };
  }

  const text = input.content ?? '';
  for (const { name, pattern } of SECRET_PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    // Keyed on THIS matched text in THIS file. Every other pattern, and every
    // other match in the same file, is still scanned.
    const excused = fixtureExceptionReason(path, m[0], list);
    if (excused) {
      exceptions.push({ file: path, line: lineOf(text, m.index), detector: `secret shape: ${name}`, reason: excused });
      continue;
    }
    findings.push({
      file: path,
      detector: 'content',
      severity: 'blocked',
      line: lineOf(text, m.index),
      reason: `secret shape: ${name}`,
    });
  }
  const tag = WRAPPER_TAG.exec(text);
  if (tag && WRAPPED_PAYLOAD.test(text)) {
    findings.push({
      file: path,
      detector: 'transcript',
      severity: 'blocked',
      line: lineOf(text, tag.index),
      reason: 'channel material: wrapper tag carrying a real payload marker',
    });
  }
  for (const { name, pattern } of TRANSCRIPT_PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    const excused = fixtureExceptionReason(path, m[0], list);
    if (excused) {
      exceptions.push({ file: path, line: lineOf(text, m.index), detector: `channel material: ${name}`, reason: excused });
      continue;
    }
    findings.push({
      file: path,
      detector: 'transcript',
      severity: 'blocked',
      line: lineOf(text, m.index),
      reason: `channel material: ${name}`,
    });
  }
  return { findings, exceptions };
}

/**
 * The whole change set.
 *
 * An EMPTY set fails. That is the point of the gate: "nothing to check" is what
 * a broken file-list computation looks like from the inside, and it is the most
 * common silent fail-open. The caller must pass a non-empty set or explain
 * itself upstream.
 */
export function runGate(inputs: ScanInput[]): GateResult {
  const allowlisted = inputs
    .map((i) => ({ file: i.path, reason: allowlistReason(i.path) }))
    .filter((a): a is { file: string; reason: string } => a.reason !== null);

  // A malformed exception must never be an invisible widening of the gate.
  const badExceptions = invalidFixtureExceptions().map((b): Finding => ({
    file: `(fixture exception) ${b.path}`,
    detector: 'unscannable',
    severity: 'unscannable',
    reason: `${b.reason} -- the gate refuses to run with an exception it cannot justify`,
  }));

  if (inputs.length === 0) {
    return {
      ok: false,
      scannedCount: 0,
      allowlisted,
      exceptions: [],
      findings: [{
        file: '(file set)',
        detector: 'unscannable',
        severity: 'unscannable',
        reason: 'the file set is EMPTY -- the gate cannot determine what to check, which is a failure, not a pass (EVIDGUARD818 fail-closed rule)',
      }],
    };
  }

  const outcomes = inputs.map((i) => scanFileDetailed(i));
  const findings = [...badExceptions, ...outcomes.flatMap((o) => o.findings)];
  const exceptions = outcomes.flatMap((o) => o.exceptions);
  return { ok: findings.length === 0, findings, scannedCount: inputs.length, allowlisted, exceptions };
}
