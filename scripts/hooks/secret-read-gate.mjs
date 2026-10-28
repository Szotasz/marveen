#!/usr/bin/env node
// PreToolUse hook (Bash): the secret-read gate. SECRETREADGATE1028, kanban 3ddab86a, owner GO for the PR
// (2026-10-28).
//
// WHY A HOOK. Permissive sub-agents run with --dangerously-skip-permissions, so a profile's allow list
// does not bind them; what binds is permissions.deny (checked before the bypass) and PreToolUse hooks.
// FLEET_BASELINE_DENY denies the credential directories in Read(...) form only, so the same files were
// one `cat ~/.ssh/id_ed25519` or `python3 -c "open('.env')"` away from the shell. This hook judges the
// Bash command line and stops a command that REFERS to a secret path, whatever program it names.
//
// PROTECTED (see RULES): ~/.ssh/**, ~/.aws/**, ~/.gnupg/**, ~/Library/Keychains/**, ~/.claude.json and
// its backups (~/.claude.json.*), <root>/store/vault*, <root>/store/.claude-oauth-token*, the other store
// credentials (store/.fal-key*, store/.fb-page-token, store/.launch-secrets, store/*-mcp-key*.txt), and by file
// name anywhere: .env, .env.* (not the .example / .sample / .template / .dist templates),
// service-account*.json, *.pem, *.key.
// ALWAYS FREE: <root>/store/.dashboard-token. Every agent reads it in each dashboard call
// (`curl -H "Authorization: Bearer $(cat .../store/.dashboard-token)" http://localhost:...`); a gate that
// stopped it would silence the fleet.
//
// HOW IT READS THE COMMAND. It does not try to know which programs read files: any reference counts, an
// argument of cat / cp / tar / base64 as much as a path inside a `python3 -c` or `node -e` body. The
// command text is cut into path-shaped candidates twice, as written and with shell quoting removed (so
// `~/.s"s"h` is ~/.ssh), and each candidate is
//   - expanded: brace lists, `~`, `$HOME`, `${HOME}`, and variables assigned in the same command;
//   - resolved: an absolute path as it is, a relative one against the hook's cwd and every `cd` /
//     `pushd` target in the command (a bare `cd` is home), and against home when the code builds a
//     home path (Path.home(), expanduser, os.homedir(), $HOME ...);
//   - glob-expanded against the filesystem when it holds * ? [ (bounded), so `~/.ss?/id*` is caught;
//   - followed through a symlink when it exists, so a link made earlier into ~/.ssh is caught.
// The file-name rules (.env, *.pem, *.key, service-account*.json) need the file to exist: `obj.key` in a
// Python one-liner is an attribute, and a message that mentions config/.env reads nothing. The directory
// and fixed-file rules do not: naming ~/.ssh is enough.
// A heredoc body is read only where an interpreter or a shell runs it as its program (`python3 - <<'PY'`,
// `bash <<EOF`, `bash -s`); fed to anything else (`cat > notes.md <<'EOF'`, `gh pr create --body
// "$(cat <<'EOF' ...)"`, `bash scripts/agent-msg.sh a b - <<'EOF'`) it is data, not a read, and is
// blanked -- unless the same command can still run or consume it (a pipe into an interpreter or shell,
// eval, source, `.`, xargs, a `read` loop): then every body is read.
// Case: on macOS and Windows the comparison is case-insensitive, as the filesystem is.
//
// MODE. `warn` (the default): a hit is logged and the call goes through, for the two-day rollout review.
// `block`: a hit is denied with the rule and the path named. Switch: the `--block` argument, which the
// scaffold writes from the SECRET_READ_GATE_BLOCK dashboard setting (not a store file a sub-agent could
// rewrite to switch itself back); env SECRET_READ_GATE_MODE=block|warn overrides it, for tests. The log
// (store/secret-read-gate.log, JSONL) holds time, mode, agent, cwd, rule, pattern, the matched path, the
// program names of the command and a hash of it -- never the command text, which may carry a value.
//
// WHAT THIS DOES NOT CLOSE, said here so nobody reads "merged" as "closed":
//   - a script written to a file first and run afterwards: the hook sees the script's name only;
//   - a path assembled at run time from pieces (`'.ss' + 'h'`, `${X}h`, base64, a value read from a file);
//   - a relative path behind a cd the command does not show (an earlier call's cwd is not tracked beyond
//     the payload's cwd);
//   - a secret file that is not on the list: adding a rule is a one-line change once the owner names it.
//
// An internal error follows the mode: in block mode it denies (fail-closed), in warn mode it is logged
// as an `internal-error` hit and allowed. Unparseable hook input (not a Bash call at all) exits 0. Only
// exit 0 is used; a deny rides on stdout as the PreToolUse decision.
import { readFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, basename, isAbsolute, sep } from 'node:path'
import { homedir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const LOG_PATH = process.env.SECRET_READ_GATE_LOG || join(ROOT, 'store', 'secret-read-gate.log')

const ENV_TEMPLATE = /^\.env\.(?:example|sample|template|dist)$/
// Lower case on purpose: the rules compare case-folded names on a case-insensitive filesystem.
const STORE_SECRET = /^(?:\.fal-key.*|\.fb-page-token.*|\.launch-secrets.*|.+-mcp-key.*\.txt)$/

// A rule: id (named in the log and the deny), the pattern as a human reads it, and the test on a
// normalized absolute path. `byName` rules apply only to a path that exists: reading a missing file reveals
// nothing, and a name in prose (`obj.key`, a message that mentions config/.env) is not a read.
// CASE. The default macOS volume (APFS) and NTFS are case-insensitive: `cat ~/.SSH/ID_RSA` opens
// ~/.ssh/id_rsa. There every rule compares lower-cased paths; elsewhere the comparison is exact.
export const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32'
const foldCase = (insensitive) => (insensitive ? (s) => s.toLowerCase() : (s) => s)
export function rules(home, root, insensitive = CASE_INSENSITIVE_FS) {
  const fold = foldCase(insensitive)
  return exactRules(home, root, fold).map((r) => ({ ...r, test: (p) => r.test(fold(p)) }))
}
// Every fixed name is written in lower case below, so folding the joined directories is enough.
function exactRules(rawHome, root, fold) {
  const home = fold(rawHome)
  const under = (dir) => { const d = fold(dir); return (p) => p === d || p.startsWith(d + sep) }
  const store = fold(join(root, 'store'))
  return [
    { id: 'ssh', pattern: '~/.ssh/**', test: under(join(home, '.ssh')) },
    { id: 'aws', pattern: '~/.aws/**', test: under(join(home, '.aws')) },
    { id: 'gnupg', pattern: '~/.gnupg/**', test: under(join(home, '.gnupg')) },
    { id: 'keychains', pattern: '~/Library/Keychains/**', test: under(join(home, 'Library', 'Keychains')) },
    { id: 'claude-json', pattern: '~/.claude.json', test: (p) => dirname(p) === home && /^\.claude\.json(?:\..*)?$/.test(basename(p)) },
    { id: 'store-vault', pattern: '${PROJECT_ROOT}/store/vault*', test: (p) => dirname(p) === store && basename(p).startsWith('vault') },
    { id: 'oauth-token', pattern: '${PROJECT_ROOT}/store/.claude-oauth-token', test: (p) => dirname(p) === store && basename(p).startsWith('.claude-oauth-token') },
    // The install's other credentials (owner decision, 2026-10-28): read by their own scripts (fb-page.py,
    // kmcp.py, fal-mcp-bekotes.sh), which run untouched -- the hook sees only the script's name.
    { id: 'store-secret', pattern: '${PROJECT_ROOT}/store/{.fal-key*,.fb-page-token,.launch-secrets,*-mcp-key*.txt}', test: (p) => dirname(p) === store && STORE_SECRET.test(basename(p)) },
    { id: 'env', pattern: '**/.env, **/.env.*', byName: true, test: (p) => { const b = basename(p); return b === '.env' || (b.startsWith('.env.') && !ENV_TEMPLATE.test(b)) } },
    { id: 'service-account', pattern: '**/service-account*.json', byName: true, test: (p) => /^service-account.*\.json$/.test(basename(p)) },
    { id: 'pem', pattern: '**/*.pem', byName: true, test: (p) => /.\.pem$/.test(basename(p)) },
    { id: 'key', pattern: '**/*.key', byName: true, test: (p) => /.\.key$/.test(basename(p)) },
  ]
}
export function allowed(p, root, insensitive = CASE_INSENSITIVE_FS) {
  const fold = foldCase(insensitive)
  return fold(p) === fold(join(root, 'store', '.dashboard-token'))
}

const INTERPRETER = /^(?:python(?:\d+(?:\.\d+)?)?|node(?:js)?|perl|ruby|php|deno|bun|osascript|bash|sh|zsh|dash|ksh|fish)$/

// Blank the body of every heredoc that is not a program's input. The scan tracks quotes so a `<<` inside
// a quoted string is not an operator; the command word is the first word of the segment the operator
// sits in. Length-preserving, so nothing else moves.
// `shellOnly` (the brace-expansion pass): keep only the bodies a SHELL runs as its program, since bash
// brace-expands those and python / node / php never do; the sink rule below still keeps every body.
export function blankInertHeredocs(text, { shellOnly = false } = {}) {
  const src = String(text ?? '')
  let out = ''
  let i = 0
  let quote = null
  let segStart = 0
  // A $( ... ) inside double quotes runs a command: its text is unquoted again until the matching ).
  const outer = []
  while (i < src.length) {
    const c = src[i]
    if (quote === '"' && c === '$' && src[i + 1] === '(') { outer.push(quote); quote = null; out += '$('; i += 2; segStart = out.length; continue }
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < src.length) { out += src.slice(i, i + 2); i += 2; continue }
      if (c === quote) quote = null
      out += c; i++; continue
    }
    if (c === ')' && outer.length) { quote = outer.pop(); out += c; i++; continue }
    if (c === '$' && src[i + 1] === '(') { outer.push(null); out += '$('; i += 2; segStart = out.length; continue }
    if (c === "'" || c === '"' || c === '`') { quote = c === '`' ? null : c; out += c; i++; continue }
    if (c === '\\' && i + 1 < src.length) { out += src.slice(i, i + 2); i += 2; continue }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '(') { segStart = out.length + 1 }
    const here = c === '<' ? /^<<-?[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|([A-Za-z_][\w.-]*))/.exec(src.slice(i)) : null
    if (here && src[i + 2] !== '<') {
      const tag = here[1] ?? here[2] ?? here[3]
      out += here[0]; i += here[0].length
      const nl = src.indexOf('\n', i)
      if (nl === -1) { out += src.slice(i); break }
      out += src.slice(i, nl + 1); i = nl + 1
      const endRx = new RegExp(`^[ \\t]*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm')
      const rest = src.slice(i)
      const m = endRx.exec(rest)
      const bodyLen = m ? m.index : rest.length
      const body = rest.slice(0, bodyLen)
      const prog = programOnStdin(out.slice(segStart))
      out += (shellOnly ? prog && (SHELL.test(prog) || SHELL_OUT.test(body)) : prog) ? body : body.replace(/[^\n]/g, ' ')
      i += bodyLen
      continue
    }
    out += c; i++
  }
  // A data heredoc stays data only while nothing in the command can turn it into a program or into
  // arguments. When the command also pipes into an interpreter or shell, or runs eval / source / `.`,
  // xargs or a `read` loop, every body is judged as it is written (fail toward reading).
  return BODY_SINK.test(out) ? src : out
}
const BODY_SINK = new RegExp([
  String.raw`\|\s*(?:(?:[A-Za-z_]\w*=\S*|env|command|exec|nohup|sudo|time)\s+)*(?:\S*\/)?(?:python[\d.]*|node(?:js)?|perl|ruby|php|deno|bun|osascript|bash|sh|zsh|dash|ksh|fish)\b`,
  String.raw`(?:^|[\s;&|({` + '`' + String.raw`])(?:eval|source|xargs)\b`,
  String.raw`(?:^|[;&|({\n])\s*\.\s`,
  String.raw`\bread\b[^;&|\n]*;\s*do\b|\bwhile\b[^\n]*\bread\b`,
].join('|'))

// Does the segment's program read its PROGRAM from stdin? Its name if so, else ''. An interpreter or shell with no script file and
// no -c / -e code: `python3 - <<'PY'`, `bash <<EOF`, `bash -s`. With a script or code argument the
// heredoc is that program's DATA (`bash scripts/agent-msg.sh a b - <<'EOF'`), and data is not a read.
function programOnStdin(segment) {
  const ws = shellWords(segment.replace(/<<.*$/s, ''))
  let k = 0
  while (k < ws.length && (/^[A-Za-z_]\w*=/.test(ws[k]) || PREFIX.has(ws[k]))) k++
  const prog = basename(ws[k] ?? '')
  if (!INTERPRETER.test(prog)) return ''
  for (const [n, w] of ws.slice(k + 1).entries()) {
    if (w === '-' || w === '-s') continue
    // `deno run -`, `bun run -`: the subcommand, then the program from stdin.
    if (n === 0 && w === 'run' && /^(?:deno|bun)$/.test(prog)) continue
    if (/^-(?:c|e|E|r|p)$|^--(?:command|eval|print)$/.test(w)) return ''
    if (/^-/.test(w)) continue
    return ''
  }
  return prog
}
const SHELL = /^(?:bash|sh|zsh|dash|ksh|fish)$/
// A program body that hands a string to a shell: there an over-budget brace word is a finding too. (Its
// brace lists are expanded anyway, see findSecretReads; this list only widens the over-budget rule.)
const SHELL_OUT = /\b(?:system|exec|popen|spawn\w*|qx)\b|subprocess|shell\s*=\s*True|execSync|execFile|shell_exec|passthru|proc_open|do shell script|`|\bos\.exec|\bcommands\.|\bsh\s*\(|%x[({[]|open\s*\([^)]*\|\s*['"]|Deno\.Command|Bun\.spawn/

// The program a segment runs: past assignments and the usual prefix words, without its directory.
const PREFIX = new Set(['env', 'sudo', 'command', 'exec', 'time', 'nohup', 'nice', 'timeout', 'stdbuf', 'builtin', 'then', 'do', 'else', '!', '{'])
function commandWord(segment) {
  for (const w of shellWords(segment)) {
    if (/^[A-Za-z_]\w*=/.test(w) || PREFIX.has(w) || /^-/.test(w) || /^\d+$/.test(w)) continue
    return basename(w)
  }
  return ''
}

// Split into words, honouring quotes and backslashes (the text itself is not run).
export function shellWords(text) {
  const out = []
  let cur = null
  let i = 0
  const push = () => { if (cur !== null) out.push(cur); cur = null }
  while (i < text.length) {
    const c = text[i]
    if (/\s/.test(c)) { push(); i++; continue }
    cur ??= ''
    if (c === "'") { const e = text.indexOf("'", i + 1); const end = e === -1 ? text.length : e; cur += text.slice(i + 1, end); i = end + 1; continue }
    if (c === '"') {
      let j = i + 1
      // Inside double quotes bash drops a backslash only before $ ` " \ and a newline: `"\.env"` stays a
      // regex, not the file .env.
      while (j < text.length && text[j] !== '"') { if (text[j] === '\\' && j + 1 < text.length && /[$`"\\\n]/.test(text[j + 1])) { cur += text[j + 1]; j += 2; continue } cur += text[j]; j++ }
      i = j + 1; continue
    }
    if (c === '\\' && i + 1 < text.length) { cur += text[i + 1]; i += 2; continue }
    cur += c; i++
  }
  push()
  return out
}

// Path-shaped pieces: everything between characters a path in this install does not contain.
const SEPARATORS = /[\s'"`;|&()<>=:,]+/
function pieces(s) { return s.split(SEPARATORS).filter((x) => x && /[A-Za-z]/.test(x)) }

// The first brace list in a word that bash expands ({a,b}; not ${VAR} and not a comma-less {x}), as
// its variants, or null. One pass with a stack, so an unmatched `{` costs no rescan.
function firstBraceList(w) {
  const stack = []
  let best = null
  for (let k = 0; k < w.length; k++) {
    const c = w[k]
    if (c === '{') stack.push({ at: k, isVar: w[k - 1] === '$', commas: [] })
    else if (c === ',' && stack.length) stack[stack.length - 1].commas.push(k)
    else if (c === '}' && stack.length) {
      const g = stack.pop()
      if (!g.isVar && g.commas.length && (!best || g.at < best.at)) best = { ...g, end: k }
    }
  }
  if (!best) return null
  const variants = []
  let from = best.at + 1
  for (const c of [...best.commas, best.end]) { variants.push(w.slice(0, best.at) + w.slice(from, c) + w.slice(best.end + 1)); from = c + 1 }
  return variants
}

// Brace expansion, iterative and bounded: at most MAX_BRACE finished words and MAX_BRACE_STEPS list
// expansions, so a crafted word can neither run the stack out nor blow up. A word whose expansion does
// not fit the budget is NOT judged as written (a padded `~/.{ssh,x}` would pass that way): the result
// says `truncated`, and the caller counts it as a finding.
const MAX_BRACE = 64
const MAX_BRACE_STEPS = 256
const MAX_BRACE_WORD = 4096
const MAX_BRACE_TOKENS = 512
const MAX_LINEAR = 1024
const MAX_BRACE_CHARS = 4_000_000
// A command longer than this is not brace-expanded at all: an unreadable-braces finding, fail-closed
// in block mode. It bounds every expansion budget below by one number, whatever the word looks like.
// 64 KB: none of 9118 measured agent commands came near it (the longest was 18.6 KB), while a command
// just under 256 KB ran 3.5 s alone and 10.6 s under load, against a 10 s hook timeout.
export const MAX_COMMAND_CHARS = 64 * 1024
// The fallback when a word does not fit the full expansion: every alternative of every top-level brace
// list once, with the other lists set to their first alternative, and once with them removed. Linear in
// the number of alternatives instead of their product. It does not reproduce every combination, but the
// directory rules are prefix rules, so the alternative that names .ssh / .aws is always among them,
// whatever padding the other lists add.
// Does the word hold a brace list inside another list? One stack pass (a regex for it backtracks
// quadratically on a long word: measured 19 s on a 250 KB one).
export function hasNestedList(word) {
  const stack = []
  for (let k = 0; k < word.length; k++) {
    const c = word[k]
    if (c === '{') stack.push({ isVar: word[k - 1] === '$', commas: false })
    else if (c === ',' && stack.length) stack[stack.length - 1].commas = true
    else if (c === '}' && stack.length) {
      const g = stack.pop()
      if (!g.isVar && g.commas && stack.some((o) => !o.isVar)) return true
    }
  }
  return false
}

export function linearBraceVariants(word) {
  const groups = []
  const stack = []
  for (let k = 0; k < word.length; k++) {
    const c = word[k]
    if (c === '{') stack.push({ at: k, isVar: word[k - 1] === '$', commas: [] })
    else if (c === ',' && stack.length) stack[stack.length - 1].commas.push(k)
    else if (c === '}' && stack.length) {
      const g = stack.pop()
      if (!stack.length && !g.isVar && g.commas.length) {
        const alts = []
        let from = g.at + 1
        for (const x of [...g.commas, k]) { alts.push(word.slice(from, x)); from = x + 1 }
        groups.push({ at: g.at, end: k, alts })
      }
    }
  }
  if (!groups.length) return [word]
  const build = (pick) => {
    let out = ''
    let from = 0
    groups.forEach((g, gi) => { out += word.slice(from, g.at) + pick(gi, g); from = g.end + 1 })
    return out + word.slice(from)
  }
  // The "others removed" variants come first, then "others at their first alternative"; both stop at
  // MAX_LINEAR. The hard command-length cap in findSecretReads keeps the word itself bounded.
  const variants = new Set([build((_, g) => g.alts[0]), build(() => '')])
  for (let i = 0; i < groups.length && variants.size < MAX_LINEAR; i++) {
    for (const alt of groups[i].alts) {
      variants.add(build((gi) => (gi === i ? alt : '')))
      if (variants.size >= MAX_LINEAR) break
    }
  }
  for (let i = 0; i < groups.length && variants.size < MAX_LINEAR; i++) {
    for (const alt of groups[i].alts) {
      variants.add(build((gi, g) => (gi === i ? alt : g.alts[0])))
      if (variants.size >= MAX_LINEAR) break
    }
  }
  return [...variants]
}

export function braceExpand(word) {
  // A cheap cap first: a word this long, or with this many braces, gets the linear fallback only.
  if (word.length > MAX_BRACE_WORD || (word.match(/\{/g) ?? []).length > MAX_BRACE_STEPS) return { words: linearBraceVariants(word), truncated: true }
  const words = []
  const work = [word]
  let steps = 0
  while (work.length) {
    const w = work.shift()
    const variants = firstBraceList(w)
    if (!variants) { words.push(w); if (words.length > MAX_BRACE) return { words: [...words.slice(0, MAX_BRACE), ...linearBraceVariants(word)], truncated: true }; continue }
    if (++steps > MAX_BRACE_STEPS || work.length + variants.length > MAX_BRACE * 4) return { words: [...words, ...linearBraceVariants(word)], truncated: true }
    work.push(...variants)
  }
  return { words, truncated: false }
}

const HOME_IN_CODE = /Path\.home\(|expanduser|homedir\(|os\.environ(?:\.get)?[[(]\s*['"]HOME|getenv\(\s*['"]HOME|ENV\[\s*['"]HOME|process\.env\.HOME|\$ENV\{HOME\}|\$HOME\b|\$\{HOME\}/

function expandVars(s, vars, home) {
  let x = s.replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME\b|\$ENV\{HOME\}/g, home)
  for (let k = 0; k < 2; k++) {
    x = x.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a, b) => (vars.has(a ?? b) ? vars.get(a ?? b) : m))
  }
  return x.replace(/^~(?=\/|$)/, home)
}

const MAX_GLOB = 256
function globRegex(seg) {
  let re = ''
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      const e = seg.indexOf(']', i + 2)
      if (e === -1) { re += '\\['; continue }
      re += '[' + seg.slice(i + 1, e).replace(/^[!^]/, '^').replace(/[\\\]]/g, '\\$&') + ']'
      i = e
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  }
  try { return new RegExp(`^${re}$`) } catch { return null }
}
// Expand an absolute glob against the filesystem, the way bash would.
function expandGlob(abs) {
  let paths = [sep]
  for (const seg of abs.split(sep).filter(Boolean)) {
    const next = []
    for (const p of paths) {
      if (!/[*?[]/.test(seg)) { next.push(join(p, seg)); continue }
      const re = globRegex(seg)
      if (!re) continue
      let names = []
      try { names = readdirSync(p) } catch { continue }
      // As bash without dotglob: a leading dot is matched only by a segment that starts with one.
      for (const n of names) if (re.test(n) && (!n.startsWith('.') || seg.startsWith('.'))) next.push(join(p, n))
      if (next.length > MAX_GLOB) break
    }
    paths = next.slice(0, MAX_GLOB)
    if (!paths.length) break
  }
  return paths
}

// realpathSync.native asks the OS, which also returns the on-disk case of every component.
function realOrNull(p) { try { return realpathSync.native(p) } catch { return null } }

// Judge one command: the list of hits, each { rule, pattern, path }. Pure apart from read-only
// filesystem lookups (existence, directory listing for a glob, symlink target).
export function findSecretReads(command, { cwd = process.cwd(), home = homedir(), root = ROOT, caseInsensitive = CASE_INSENSITIVE_FS } = {}) {
  const text = blankInertHeredocs(String(command ?? '').replace(/\\\r?\n/g, ' '))
  const words = shellWords(text)
  const vars = new Map()
  for (const w of words) {
    const m = /^([A-Za-z_]\w*)=(.*)$/s.exec(w)
    if (m) vars.set(m[1], m[2].split(/[;&|]/)[0])
  }
  const bases = [isAbsolute(cwd) ? cwd : process.cwd()]
  const cdRx = /(?:^|[;&|(\n{]|\bthen|\bdo)\s*(?:cd|pushd)(?=[\s;&|)]|$)([^;&|)\n]*)/g
  for (const m of text.matchAll(cdRx)) {
    const arg = shellWords(m[1]).find((w) => !/^-/.test(w))
    if (!arg) { bases.push(home); continue }
    const t = expandVars(arg, vars, home)
    if (!t.includes('$')) bases.push(isAbsolute(t) ? resolve(t) : resolve(bases[0], t))
  }
  const homeInCode = HOME_IN_CODE.test(text)
  if (homeInCode) bases.push(home)

  // Brace lists are expanded on whole words, before the cut: the cut splits on the comma.
  // Brace lists are expanded in every PROGRAM text, the command's own words and every program body
  // (`text`: data bodies blanked), and only the expanded variants are judged, so a JSON or PHP body
  // costs nothing: its `{a,b}` variants match no rule. A list of ways a body can reach a shell would
  // never be complete, so none is needed for that part. The OVER-BUDGET finding is narrower: it counts
  // only in shell text (the command's words and the bodies a shell runs or the command pipes on, plus
  // a body with a recognised shell-out), where bash really expands; a program body over the budget is
  // judged as written. The number of brace words is bounded per command too.
  const tooLong = String(command ?? '').length > MAX_COMMAND_CHARS
  const braceTokens = (t) => (tooLong ? [] : t.split(/\s+/).filter((x) => x.includes('{')).flatMap((x) => shellWords(x)))
  const shellText = new Set(braceTokens(blankInertHeredocs(String(command ?? '').replace(/\\\r?\n/g, ' '), { shellOnly: true })))
  // Deduplicated; past the per-command budget a word gets the linear fallback, never nothing. The total
  // work is capped as well (MAX_BRACE_CHARS over all variants): past it, no more expansion, a finding.
  const programTokens = [...new Set(braceTokens(text))]
  let budget = MAX_BRACE_CHARS
  let overWork = false
  const expanded = []
  for (const [n, t] of programTokens.entries()) {
    if (budget <= 0) { overWork = true; break }
    const e = n < MAX_BRACE_TOKENS ? braceExpand(t) : { words: linearBraceVariants(t), truncated: true }
    // A list nested in a fallback word's alternative is not expanded by the linear fallback: unreadable.
    const nested = e.truncated && hasNestedList(t)
    budget -= e.words.reduce((a, w) => a + w.length, 0)
    expanded.push({ ...e, shell: shellText.has(t), pathShaped: /[~/]/.test(t), nested })
  }
  const candidates = new Set([...pieces(text), ...words.flatMap(pieces), ...expanded.flatMap((e) => e.words.flatMap(pieces))])
  const ruleList = rules(home, root, caseInsensitive)
  const homePrefix = foldCase(caseInsensitive)(home + sep)
  const hits = []
  // Every word over a budget is still judged, on its linear variants. Besides, it is a finding of its
  // own (logged in warn mode, denied in block mode) when it is shell text (bash expands it in full) or
  // PATH-SHAPED (holds `~` or `/`) anywhere: the linear variants are not every combination. A program-body
  // word with neither is not a finding, because JSON / PHP bodies would then deny ordinary work. So is a
  // command past the total work budget, and a fallback word with a nested list.
  if (tooLong) hits.push({ rule: 'unreadable-braces', pattern: `command over ${MAX_COMMAND_CHARS} characters`, path: '-' })
  else if (overWork || expanded.some((e) => e.truncated && (e.shell || e.pathShaped || e.nested))) hits.push({ rule: 'unreadable-braces', pattern: `brace expansion over ${MAX_BRACE} words`, path: '-' })
  const seen = new Set()
  const judge = (abs) => {
    for (const p of [abs, realOrNull(abs)]) {
      if (!p || allowed(p, root, caseInsensitive)) continue
      for (const r of ruleList) {
        if (!r.test(p) || (r.byName && !existsSync(p))) continue
        const key = `${r.id}\0${p}`
        const shown = foldCase(caseInsensitive)(p).startsWith(homePrefix) ? '~' + p.slice(home.length) : p
        if (!seen.has(key)) { seen.add(key); hits.push({ rule: r.id, pattern: r.pattern, path: shown }) }
      }
    }
  }
  for (const raw of candidates) {
    const e = braceExpand(raw)
    // Over the cap a piece is still judged as written; the word-level finding above covers the rest.
    for (const variant of (e.words.length ? e.words : [raw])) {
      const x = expandVars(variant, vars, home)
      // `process.env.HOME + '/.ssh/x'`: next to code that builds a home path, a leading `/` piece is
      // also read as home-relative.
      const targets = isAbsolute(x)
        ? [resolve(x), ...(homeInCode ? [resolve(home, '.' + x)] : [])]
        : bases.map((b) => resolve(b, x))
      for (const t of targets) {
        if (/[*?[]/.test(t)) {
          judge(t)
          for (const g of expandGlob(t)) judge(g)
        } else {
          judge(t)
        }
      }
    }
  }
  return hits
}

export function readMode(argv = process.argv, env = process.env) {
  const fromEnv = env.SECRET_READ_GATE_MODE
  if (fromEnv === 'block' || fromEnv === 'warn') return fromEnv
  return argv.includes('--block') ? 'block' : 'warn'
}

// Who ran it, for the review: the agent directory the session lives in, from its config dir or cwd.
export function agentOf(env = process.env, cwd = '') {
  for (const p of [env.CLAUDE_CONFIG_DIR ?? '', cwd]) {
    const m = /\/agents\/([^/]+)(?:\/|$)/.exec(p)
    if (m) return m[1]
  }
  return null
}

function programsOf(command) {
  const text = blankInertHeredocs(String(command ?? ''))
  return [...new Set(text.split(/[;&|\n]+|\$\(|`/).map(commandWord).filter(Boolean))].slice(0, 8)
}

export const GATE_MSG = 'szef-kapu: a parancs titkos utvonalra hivatkozik, ezert TILTVA. A titkos fajlokat (kulcsok, tokenek, .env) ugynok shellbol nem olvashatja; ha a feladathoz tenyleg kell, szolj a fo-ugynoknek.'

function isInvokedDirectly() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === (process.argv[1] ? realpathSync(process.argv[1]) : '') } catch { return false }
}

if (isInvokedDirectly()) {
  let payload
  try { payload = JSON.parse(readFileSync(0, 'utf-8')) } catch { process.exit(0) }
  if (payload?.tool_name !== 'Bash') process.exit(0)
  const command = payload?.tool_input?.command
  const cwd = typeof payload?.cwd === 'string' && payload.cwd.startsWith('/') ? payload.cwd : process.cwd()
  const mode = readMode()
  let hits
  // An internal error is judged by the mode: block fails CLOSED (the call is denied, the reason says the
  // gate could not read it), warn lets it through and records it, like any other warn-mode finding.
  try {
    // Test seam for the error path; the hook's environment is the session's, not something a Bash call sets.
    if (process.env.SECRET_READ_GATE_FAULT === '1') throw new Error('injected fault')
    hits = findSecretReads(command, { cwd })
  } catch (e) {
    process.stderr.write(`secret-read-gate: internal error (${mode}): ${e?.message}\n`)
    hits = [{ rule: 'internal-error', pattern: '-', path: String(e?.message ?? e).slice(0, 120) }]
  }
  if (!hits.length) process.exit(0)
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, JSON.stringify({
      ts: new Date().toISOString(),
      mode,
      decision: mode === 'block' ? 'deny' : 'allow',
      agent: agentOf(process.env, cwd),
      cwd,
      hits,
      programs: programsOf(command),
      cmd_sha256: createHash('sha256').update(String(command ?? '')).digest('hex').slice(0, 16),
      cmd_len: String(command ?? '').length,
    }) + '\n')
  } catch { /* warn still allows, block still denies: the log is the record, not the decision */ }
  if (mode === 'block') {
    const named = hits.slice(0, 3).map((h) => `${h.rule}: ${h.path} (${h.pattern})`).join('; ')
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${GATE_MSG} (${named})` } }))
  }
  process.exit(0)
}
