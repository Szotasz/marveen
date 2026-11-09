// #2600: the TTS directive's command must work on a host without jq (install-linux.sh does
// not install it, a stock Ubuntu has none), and the reply text must reach the route exactly,
// with no shell expansion. The command is run here as the agent would run it, by bash with a
// PATH that holds only curl and cat, against a local server that parses with the route's own
// parseTtsRequest.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const state = vi.hoisted(() => ({ storeDir: '', port: 0 }))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  get STORE_DIR() { return state.storeDir },
  get WEB_PORT() { return state.port },
}))

const { buildTtsDirective, parseTtsRequest, TTS_TEXT_PLACEHOLDER } = await import('../web/voice-directive.js')

const PROBE_TOKEN = 'probe-token-ISSUE2600-0123456789abcdef'

interface Seen { contentType: string | undefined; auth: string | undefined; parsed: ReturnType<typeof parseTtsRequest> }

let root: string
let server: http.Server
let seen: Seen[] = []

function bashBlock(directive: string): string {
  const m = directive.match(/```bash\n([\s\S]*?)```/)
  if (!m) throw new Error('no bash block in the directive')
  return m[1]
}

// Runs the directive's command with the placeholder line replaced, as the agent does.
function runDirective(directive: string, replyText: string, pathDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const script = bashBlock(directive).replace(`${TTS_TEXT_PLACEHOLDER}\n`, `${replyText}\n`)
  return new Promise((resolve) => {
    const p = spawn('/bin/bash', ['-c', script], { cwd: root, env: { PATH: pathDir, HOME: root } })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (c) => { stdout += c })
    p.stderr.on('data', (c) => { stderr += c })
    p.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'voice-nojq-'))
  state.storeDir = join(root, 'store')
  mkdirSync(state.storeDir)
  writeFileSync(join(state.storeDir, '.dashboard-token'), `${PROBE_TOKEN}\n`)
  // A PATH with curl and cat only: no jq, no python.
  const bin = join(root, 'bin')
  mkdirSync(bin)
  for (const tool of ['curl', 'cat']) {
    symlinkSync(execFileSync('/bin/bash', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).trim(), join(bin, tool))
  }
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      seen.push({
        contentType: req.headers['content-type'],
        auth: req.headers.authorization,
        parsed: parseTtsRequest(req.headers['content-type'], Buffer.concat(chunks), url.searchParams, 'default-model'),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true,"message_id":1}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  state.port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(root, { recursive: true, force: true })
})

describe('the TTS directive works without jq (#2600)', () => {
  it('the command does not call jq', () => {
    const d = buildTtsDirective({ chatId: '1', stateDir: '/s', voiceModel: 'v' }) as string
    expect(bashBlock(d)).not.toMatch(/\bjq\b/)
  })

  it('without jq on PATH the reply text, the chat id, the state dir and the voice model all arrive', async () => {
    expect(existsSync(join(root, 'bin', 'jq'))).toBe(false)
    seen = []
    // A space, a single quote, & and = in the state dir: the query string and the shell quoting must hold.
    const stateDir = "/srv/mv/pro ject's&x=1/state"
    const d = buildTtsDirective({ chatId: '12345', stateDir, voiceModel: 'hu_HU-imre-medium' }) as string
    const text = 'Szia, ez a válaszom: "idézet", egy \' jel, egy \\ jel.\nMásodik sor, árvíztűrő tükörfúrógép.'
    const r = await runDirective(d, text, join(root, 'bin'))
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0].contentType).toBe('text/plain; charset=utf-8')
    expect(seen[0].auth).toBe(`Bearer ${PROBE_TOKEN}`)
    expect(seen[0].parsed).toEqual({ text, voiceModel: 'hu_HU-imre-medium', chatId: '12345', stateDir })
  })

  it('the shell does not expand $(...), backticks or $VARS in the reply text', async () => {
    seen = []
    const marker = join(root, 'INJECTED')
    const d = buildTtsDirective({ chatId: '1', stateDir: '/s', voiceModel: 'v' }) as string
    const text = `a $(touch ${marker}) b \`touch ${marker}\` c $HOME d`
    const r = await runDirective(d, text, join(root, 'bin'))
    expect(r.code).toBe(0)
    expect(existsSync(marker)).toBe(false)
    expect(seen[0].parsed?.text).toBe(text)
  })
})

describe('the heredoc end marker is new for every directive (Dani, #2605 review)', () => {
  const MARKER_RE = /--data-binary @- <<'(MARVEEN_TTS_END_[0-9a-f]{16})'\n[\s\S]*?\n(MARVEEN_TTS_END_[0-9a-f]{16})\n```/

  it('the opening and closing marker match, and two directives get different markers', () => {
    const a = buildTtsDirective({ chatId: '1', stateDir: '/s', voiceModel: 'v' }) as string
    const b = buildTtsDirective({ chatId: '1', stateDir: '/s', voiceModel: 'v' }) as string
    const ma = a.match(MARKER_RE)
    const mb = b.match(MARKER_RE)
    expect(ma).not.toBeNull()
    expect(mb).not.toBeNull()
    expect(ma?.[1]).toBe(ma?.[2])
    expect(mb?.[1]).toBe(mb?.[2])
    expect(ma?.[1]).not.toBe(mb?.[1])
    // The instruction names the same marker the command uses.
    expect(a).toContain(`a ${ma?.[1]} sor maradjon`)
  })

  it('a reply line equal to a predictable marker stays part of the text', async () => {
    seen = []
    const d = buildTtsDirective({ chatId: '1', stateDir: '/s', voiceModel: 'v' }) as string
    const text = ['Első sor', 'MARVEEN_TTS_END', 'MARVEEN_TTS_END_', 'Utolsó sor'].join('\n')
    const r = await runDirective(d, text, join(root, 'bin'))
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0].parsed?.text).toBe(text)
  })
})

describe('parseTtsRequest', () => {
  const q = new URLSearchParams()

  it('reads the JSON body, as the route did before', () => {
    const body = Buffer.from(JSON.stringify({ text: ' hi ', voice_model: 'm', chat_id: 42, state_dir: '/s ' }))
    expect(parseTtsRequest('application/json', body, q, 'def')).toEqual({ text: 'hi', voiceModel: 'm', chatId: '42', stateDir: '/s' })
  })

  it('a JSON body without voice_model gets the default', () => {
    expect(parseTtsRequest(undefined, Buffer.from('{"text":"x"}'), q, 'def')?.voiceModel).toBe('def')
  })

  it('a body that is not JSON (the old pipe without jq sent an empty one) is null', () => {
    expect(parseTtsRequest('application/json', Buffer.from(''), q, 'def')).toBeNull()
  })

  it('a text/plain body with an empty voice_model gets the default', () => {
    const query = new URLSearchParams({ chat_id: '1', state_dir: '/s', voice_model: '' })
    expect(parseTtsRequest('TEXT/PLAIN', Buffer.from('szöveg\n'), query, 'def')).toEqual({ text: 'szöveg', voiceModel: 'def', chatId: '1', stateDir: '/s' })
  })
})
