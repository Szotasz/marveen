// VOICETOKENLEAK1101 round 2: the kanban dispatch recipe's commands are scripts/marveen-api.sh calls. Tests run a
// recipe line for real against a local capture server, so what they check is what reaches the wire (method, path,
// JSON body, the token header), not the text of the line. The .txt payload files the recipe names (in the agent's
// own directory) are swapped for temp files with the given content.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { AddressInfo } from 'node:net'

export interface Captured { method: string, url: string, headers: IncomingMessage['headers'], body: Record<string, unknown> | null, argv: string[] }

export const RECIPE_TOKEN = 'recipe-test-token-0123456789'

/** The recipe line that runs `verb` with these leading args (e.g. ['t-1', 'done']). */
export function recipeLine(out: string, verb: string, ...args: string[]): string {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`marveen-api\\.sh ${[verb, ...args].map(esc).join(' ')}(\\s|$)`)
  const line = out.split('\n').find((l) => re.test(l))
  if (!line) throw new Error(`no recipe line for ${verb} ${args.join(' ')}`)
  return line
}

/** Runs one recipe line (a `bash .../marveen-api.sh ...` command, no pipe) against a capture server. */
export async function runRecipeLine(line: string, files: Record<string, string> = {}, reply = '{"ok":true}'): Promise<Captured> {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-recipe-'))
  const tokenFile = join(dir, '.dashboard-token')
  writeFileSync(tokenFile, RECIPE_TOKEN + '\n')
  // The line runs as the agent runs it: through bash, so its quoting (a name with a space) counts. The .txt payload
  // files it names are swapped for temp files first.
  const cmd = line.trim().replace(/\S+\.txt\b/g, (w) => {
    const p = join(dir, basename(w))
    writeFileSync(p, files[basename(w)] ?? 'tartalom')
    return p
  })
  if (!/^bash \S+marveen-api\.sh /.test(cmd)) throw new Error('not a helper line: ' + line)
  const argv = ['-c', cmd]
  let got: Captured | null = null
  const srv: Server = await new Promise((resolve) => {
    const s = createServer((req, res) => {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        got = { method: req.method!, url: req.url!, headers: req.headers, body: b ? JSON.parse(b) : null, argv }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(reply)
      })
    })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('bash', argv, {
        env: { PATH: process.env.PATH!, MARVEEN_API_BASE: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, MARVEEN_TOKEN_FILE: tokenFile },
        timeout: 20_000,
      }, (err, _stdout, stderr) => (err ? reject(new Error(stderr || String(err))) : resolve()))
    })
  } finally {
    srv.close()
  }
  if (!got) throw new Error('nothing reached the server')
  return got
}
