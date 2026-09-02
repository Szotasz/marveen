// mio-scan, Node/TS port for the `marveen skill` CLI (MIOCLISKILL831).
//
// EZ A SZABALYKESZLET HARMADIK PELDANYA, es ezt ki kell mondani:
//   1. packages/mio-agent-security/bin/mio-scan  (Python, az EREDETI)
//   2. marveen-io supabase/functions/_shared/mio-scan.ts  (Deno, a webes ut)
//   3. ez a fajl  (Node, a CLI-ut)
// Harom peldany egy szabalykeszletbol csendben elcsuszik egymastol, es a
// kovetkezmeny nem elmeleti: ugyanaz a fajl az egyik uton atmenne, a masikon
// nem, mikozben mindharom "mio-scan 1.0.0 / 2026-08-24"-nek nevezi magat.
// Ezert a masolat MELLE koltozott a bizonyitek is: a fixture-keszlet, a
// PYTHON eredetibol generalt aranyfajlok, es az ot mutacios kontroll
// (src/__tests__/skill-scan-parity.test.ts). A drift igy MERT, nem remelt.
// A szabalykeszlet ADATKENT valo kiszervezese kulon tetel (MIOSCANRULES831).
//
// OT CSENDES Python/JS ELTERES van bezarva ide. Mindegyik nema: a minta ugy
// is, ugy is leforditodik, csak MAS halmazra illeszkedik.
//
//   1. INLINE FLAGEK. A Python `(?i)` / `(?is)` elotagja RegExp-flagge valik.
//   2. SZOHATAR. A Python `\b`-je str-en UNICODE-TUDATOS, a JavaScripte nem:
//      a JS-nek az `a` ekezetes valtozata nem szo-karakter, tehat a hatar egy
//      MAGYAR SZO KOZEPEN tuzel. Ket szabaly magyarul van irva. Minden `\b` a
//      hatar PONTOS jelentesere fordul (a ket oldalbol pontosan az egyik
//      szo-karakter), nem az iranyanak talalgatasara.
//   3. SZAMJEGYEK. A Python `\d`-je str-en `\p{Nd}`, a JavaScripte csak ASCII.
//   4. CSONKITAS. A Python KODPONT szerint vagja a match-reszletet, a JS
//      UTF-16 egyseg szerint -- egy emoji Pythonban egy, JS-ben ketto.
//   5. OFFSZETEK. Ugyanez all a `span`-ra. Ez rejtozott a legjobban: egy 30
//      emojis megjegyzesnel a ket implementacio UGYANAZT a match-szoveget
//      adta, es csak a span tert el, [47,196] vs [47,226].

export const SCANNER_NAME = 'mio-scan';
export const SCANNER_VERSION = '1.0.0';
export const RULEPACK = '2026-08-24';

export interface Finding {
  rule: string;
  category: 'injection' | 'pii';
  match: string;
  line: number;
  span: [number, number];
}

export interface ScanResult {
  scanner: { name: string; version: string; rulepack: string };
  findings: Finding[];
}

/** Source patterns, copied VERBATIM from the Python rulepack. */
const INJECTION_RULES: Array<[string, string]> = [
  ['ignore-previous-instructions',
    String.raw`(?i)\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all)\b.{0,30}\b(instructions?|prompts?|rules?)\b`],
  ['ignore-previous-instructions-hu',
    String.raw`(?i)\b(hagyd\s+figyelmen\s+k[ií]v[üu]l|felejtsd\s+el)\b.{0,60}\b(utas[ií]t[áa]s|szab[áa]ly|prompt)`],
  ['role-reassignment',
    String.raw`(?i)\byou\s+are\s+(now|no\s+longer)\b|\bact\s+as\s+(if\s+you\s+are\s+)?(the\s+)?(system|admin|root|developer)\b`],
  ['system-prompt-probe',
    String.raw`(?i)\b(reveal|print|show|repeat)\b.{0,30}\b(system\s+prompt|hidden\s+instructions?|initial\s+prompt)\b`],
  ['fake-system-tag',
    String.raw`(?i)<\s*/?\s*(system|assistant_instructions|important_system)[^>]*>`],
  ['imperative-html-comment',
    String.raw`(?is)<!--.{0,200}\b(you\s+must|execute|run|send|curl|fetch|post)\b.{0,400}-->`],
  ['pipe-to-shell',
    String.raw`(?i)\b(curl|wget)\b[^\n|;]{0,200}\|\s*(ba)?sh\b`],
  ['exfiltrate-instruction',
    String.raw`(?i)\b(send|post|upload|exfiltrate|forward)\b.{0,40}\b(credentials?|secrets?|tokens?|api[-_ ]?keys?|\.env|passwords?)\b`],
  ['tool-invocation-bait',
    String.raw`(?i)\b(use|call|invoke)\b.{0,20}\b(the\s+)?(bash|shell|webfetch|browser)\s+tool\b`],
  ['long-base64-blob',
    String.raw`[A-Za-z0-9+/]{240,}={0,2}`],
];

const PII_RULES: Array<[string, string]> = [
  ['email-address',
    String.raw`[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}`],
  ['hu-phone-number',
    String.raw`(?<!\d)(\+36|0036|06)[ \-]?(\d{1,2})[ \-]?\d{3}[ \-]?\d{3,4}(?!\d)`],
  ['card-number-shaped',
    String.raw`(?<!\d)(\d[ \-]?){15,16}(?!\d)`],
  ['api-key-shaped',
    String.raw`\b(sk|pk|rk)[-_](live|test|ant|proj)?[-_]?[A-Za-z0-9_\-]{16,}\b`],
  ['bearer-token-literal',
    String.raw`(?i)\bauthorization:\s*bearer\s+[A-Za-z0-9._\-]{12,}`],
  ['hu-taj-shaped',
    String.raw`(?<!\d)\d{3}[ \-]\d{3}[ \-]\d{3}(?!\d)`],
  ['secret-assignment',
    String.raw`(?i)\b(password|jelsz[óo]|secret|api[-_]?key|token)\b\s*[:=]\s*['"]?[^\s'"]{8,}`],
];

const WORD = String.raw`[\p{L}\p{N}_]`;
/** Python's `\b`: exactly one side is a word character. */
const BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;

/**
 * Translate one Python pattern into a JavaScript RegExp, closing the four
 * documented differences. The walk is character by character because the
 * substitutions must NOT fire inside a character class: `[ \-]` contains a
 * literal backslash-escape, and `[\d]` inside a class is a different context
 * from a bare `\d`.
 */
function compile(pattern: string): RegExp {
  let flags = 'gu';
  let src = pattern;
  const inline = /^\((\?[a-z]+)\)/.exec(src);
  if (inline) {
    if (inline[1].includes('i')) flags += 'i';
    if (inline[1].includes('s')) flags += 's';
    src = src.slice(inline[0].length);
  }

  let out = '';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      const next = src[i + 1];
      if (!inClass && next === 'b') {
        // Python's Unicode word boundary, spelled out EXACTLY rather than
        // guessed. A boundary is not directional: it asserts that of the two
        // sides, exactly one is a word character. An earlier version of this
        // port chose the direction from the preceding pattern text, which
        // reads correctly for `\bword` and `word\b` and silently reverses
        // after a quantifier -- `...{16,}\b` looks like neither. The parity
        // harness caught it on the api-key rule; the fix is to stop guessing.
        out += BOUNDARY;
        i++;
        continue;
      }
      if (next === 'd') {
        out += inClass ? String.raw`\p{Nd}` : String.raw`[\p{Nd}]`;
        i++;
        continue;
      }
      out += c + (next ?? '');
      i++;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    out += c;
  }
  return new RegExp(out, flags);
}

const COMPILED: Array<[string, 'injection' | 'pii', RegExp]> = [
  ...INJECTION_RULES.map(([n, p]) => [n, 'injection', compile(p)] as [string, 'injection', RegExp]),
  ...PII_RULES.map(([n, p]) => [n, 'pii', compile(p)] as [string, 'pii', RegExp]),
];

/**
 * Python indexes a str by CODE POINT; JavaScript indexes by UTF-16 code unit.
 * The high-surrogate positions are collected once per scan, so converting an
 * offset is a binary search rather than a re-walk of the prefix -- a document
 * with many findings would otherwise be quadratic.
 */
function kodpontIndexelo(text: string): (utf16Index: number) => number {
  const surrogates: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) surrogates.push(i);
  }
  if (surrogates.length === 0) return (i) => i;
  return (i) => {
    let lo = 0;
    let hi = surrogates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (surrogates[mid] < i) lo = mid + 1;
      else hi = mid;
    }
    return i - lo;
  };
}

/** Python's `snippet[:80]` cuts by code point, not by UTF-16 unit. */
function truncate(s: string): string {
  const points = Array.from(s);
  return points.length > 80 ? points.slice(0, 80).join('') + '...' : s;
}

export function scan(text: string): Finding[] {
  const findings: Finding[] = [];
  const kodpont = kodpontIndexelo(text);
  for (const [rule, category, re] of COMPILED) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const snippet = m[0];
      const startKp = kodpont(start);
      findings.push({
        rule,
        category,
        match: truncate(snippet),
        // A sorszamhoz az EGYSEG mindegy: ugyanazon a prefixen szamolunk
        // ujsorokat, es az ujsor BMP karakter.
        line: (text.slice(0, start).match(/\n/g)?.length ?? 0) + 1,
        span: [startKp, startKp + Array.from(snippet).length],
      });
    }
  }
  // Python sorts by span[0] with a stable sort, so ties keep rule order.
  return findings.sort((a, b) => a.span[0] - b.span[0]);
}

export function scanResult(text: string): ScanResult {
  return {
    scanner: { name: SCANNER_NAME, version: SCANNER_VERSION, rulepack: RULEPACK },
    findings: scan(text),
  };
}
