import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// Helpers for the curl-token tests: take the TEXT a generator hands to an agent, cut the curl commands
// out of it, check their shape, and actually RUN them against a local stub server. A shape rule
// that is only a regex over source text can pass while the emitted command does not work (the RO
// found exactly that: an unquoted $(cat <path>) in a STORE_DIR with a space); running the command
// is the only check that cannot be fooled by the way the string happens to be written.

/**
 * Join backslash-continued lines into one logical line, and keep a heredoc body attached to the
 * command that opens it. This is the exact boundary of a shell command in rendered text, so no
 * "N characters after the match" window is needed.
 */
export function logicalLines(text: string): string[] {
  const raw = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i]
    while (line.endsWith('\\') && i + 1 < raw.length) line = line.slice(0, -1) + ' ' + raw[++i].trim()
    const heredoc = /<<-?\s*'([A-Za-z_]+)'\s*$/.exec(line) ?? /<<-?\s*([A-Za-z_]+)\s*$/.exec(line)
    if (heredoc) {
      const body = [line]
      while (i + 1 < raw.length) {
        body.push(raw[++i])
        if (raw[i] === heredoc[1]) break
      }
      out.push(body.join('\n'))
    } else {
      out.push(line)
    }
  }
  return out
}

/**
 * The runnable curl commands in a rendered text: a logical line that starts (after indentation) with
 * printf / jq / curl and holds a curl with a flag, or a backticked span holding one (inline code in
 * a markdown bullet). Prose that merely mentions curl is not a command and is not returned.
 */
export function curlCommands(text: string): string[] {
  const found: string[] = []
  for (const line of logicalLines(text)) {
    const first = line.split('\n')[0]
    const inline = /`([^`]*\bcurl\s+-[^`]*)`/.exec(first)
    if (inline) {
      if (inline[1].includes('/api/')) found.push(inline[1].trim())
      continue
    }
    if (/^\s*(printf|jq|curl)\s/.test(first) && /\bcurl\s+-/.test(first) && first.includes('/api/')) found.push(line.trim())
  }
  return found
}

/** A pipeline whose first stage is the printf curl-config and whose curl takes it as -K -. */
export const PIPED_CONFIG = /printf 'header = "Authorization: Bearer %s"\\n' "(?:\$\(cat [^\n]*?\)|\$[A-Z_]+)" \| (?:[^|\n]*\| )?curl\b/

/** Shape rules for ONE rendered command. Returns the violated rules (empty = fine). */
export function shapeViolations(cmd: string): string[] {
  const bad: string[] = []
  const readsBodyFromStdin = /@-(?!\w)|<<-?\s*['"]?[A-Za-z_]+/.test(cmd)
  const piped = / -K - /.test(cmd + ' ')
  const substituted = /-K <\(/.test(cmd)
  if (piped && readsBodyFromStdin) bad.push('-K - AND a stdin body: both would read the same pipe')
  if (piped && !PIPED_CONFIG.test(cmd)) bad.push('-K - without the printf config piped in')
  if (substituted && !readsBodyFromStdin) bad.push('-K <(...) on a curl whose body is not on stdin (use printf | curl -K -)')
  if (!piped && !substituted) bad.push('no curl config (-K): the token must not be on argv')
  return bad
}

export interface SeenRequest {
  method: string
  url: string
  authorization: string | undefined
  body: string
}

/** A local server that answers every request with `[]` and remembers what it was sent. */
export async function startStub(): Promise<{ server: Server; port: number; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body: Buffer.concat(chunks).toString('utf-8') })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('[]')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port, seen }
}

/** Run one command in bash; resolves with its exit code and output. */
export function runCommand(cmd: string, cwd: string, home: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', cmd], {
      cwd,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

/** Placeholders like <id>, <N>, <PLAN_ID>, <rendszer> stand for values the agent fills in. */
export function fillPlaceholders(cmd: string, scratchDir?: string): string {
  // KULCSSZÓ is the search-word placeholder in the memory-search example; a raw accent in a query string is
  // an HTTP 400 (the documented trap), so the agent's own replacement is what makes the request valid.
  const filled = cmd.replace(/<[A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű_-]+>/g, 'x').replace(/KULCSSZÓ/g, 'KULCSSZO')
  // The examples write the response headers to /tmp/mem-fejlec*.txt, the same path a live agent uses between its
  // curl -D and its grep: running them here must not touch that file, so the scratch dir stands in for /tmp.
  return scratchDir ? filled.replace(/\/tmp\//g, `${scratchDir}/`) : filled
}

/** Ban list for the argv form, in every spelling the RO listed (and the escaped-JSON one). */
export function argvTokenHits(text: string): number[] {
  const hits: number[] = []
  const re = /Authorization:\s*Bearer/gi
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // The one allowed home of the token: the curl config that printf prints (header = "Authorization: ...").
    const before = text.slice(Math.max(0, m.index - 40), m.index)
    if (!/header = \\?"$/.test(before)) hits.push(m.index)
  }
  return hits
}
