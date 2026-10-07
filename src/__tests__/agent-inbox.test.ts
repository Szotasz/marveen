import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Card 71263d15 (B), 15060: the reader must never cut a message silently. On
// 2026-09-22 an agent answered the first 600 characters of a 1217-character
// message (the decisive sentence stood right after the cut) because its ad-hoc
// inbox command printed content[:600] and nothing else.
//
// This runs the script's actual rendering block against a fixture response, the
// way agent-msg-get-freshness.test.ts does: the check is what the reader SEES.
// `want` and `page` are the --all mode's arguments (the newest `want` incoming rows out of one API page of
// `page` rows); want = -1 is the default, pending mode.
function render(response: unknown, agent: string, max = 0, want = -1, page = 200): string {
  const script = readFileSync(new URL('../../scripts/agent-inbox.sh', import.meta.url), 'utf-8')
  const m = script.match(/python3 - "\$OUT" "\$AGENT" "\$MAX" "\$WANT" "\$PAGE" <<'PY'\n([\s\S]*?)\nPY/)
  expect(m, 'the python rendering block must still be recognizable').not.toBeNull()
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'))
  const py = join(dir, 'render.py')
  const json = join(dir, 'msgs.json')
  writeFileSync(py, m![1], 'utf-8')
  writeFileSync(json, JSON.stringify(response), 'utf-8')
  return execFileSync('python3', [py, json, agent, String(max), String(want), String(page)], { encoding: 'utf-8' })
}

const LONG = 'A'.repeat(600) + 'TEGNAP OTA MEGVALTOZOTT: ez a dönto mondat. ' + 'B'.repeat(573)
const rows = [
  { id: 102, from_agent: 'olvaso', to_agent: 'masik', status: 'pending', created_at: 1790000100, content: 'kimeno, nem ide tartozik' },
  { id: 101, from_agent: 'kuldo', to_agent: 'olvaso', status: 'pending', created_at: 1790000000, content: LONG },
  { id: 108, from_agent: 'masik', to_agent: 'olvaso', status: 'pending', created_at: 1790000200, content: 'rovid',
    freshness: { note: '[!FRISSESSEG (5p regi): azota 1 ujabb uzenet]' } },
]

describe('agent-inbox.sh never cuts a message silently (71263d15 B)', () => {
  it('prints every incoming message IN FULL by default, oldest first, with its length', () => {
    const out = render({ messages: rows }, 'olvaso')
    expect(LONG.length).toBe(1217)
    expect(out).toContain(LONG)
    expect(out).toContain('# 2 message(s) to olvaso')
    expect(out).toContain('1217 karakter')
    expect(out.indexOf('# msg 101')).toBeLessThan(out.indexOf('# msg 108'))
    expect(out).not.toContain('kimeno, nem ide tartozik')
  })

  it('⛔ with --max it says how much it cut, and how to read the rest, where the text stops', () => {
    const out = render({ messages: rows }, 'olvaso', 600)
    expect(out).toContain('A'.repeat(600) + ' [... +617 karakter levágva; teljes: bash scripts/agent-msg-get.sh 101]')
    expect(out).not.toContain('TEGNAP OTA MEGVALTOZOTT')
    // A message shorter than the cut is printed whole, with no marker.
    expect(out).toContain('\nrovid\n')
  })

  it('prints the freshness note above the content, as agent-msg-get.sh does', () => {
    const out = render(rows, 'olvaso')
    const note = '[!FRISSESSEG (5p regi): azota 1 ujabb uzenet]'
    expect(out).toContain(note)
    expect(out.indexOf(note)).toBeLessThan(out.indexOf('\nrovid'))
  })

  it('an empty inbox says so', () => {
    expect(render({ messages: [] }, 'olvaso')).toContain('# 0 message(s) to olvaso')
  })
})

describe('agent-inbox.sh --all and a dashboard that does not answer (71263d15 K6.12-K6.14)', () => {
  // One API page lists BOTH directions, newest first, at most 200 rows (src/web/routes/messages.ts).
  const page = (n: number, incomingEvery: number) => Array.from({ length: n }, (_, i) => ({
    id: 5000 + i,
    from_agent: i % incomingEvery === 0 ? 'k' : 'olvaso',
    to_agent: i % incomingEvery === 0 ? 'olvaso' : 'k',
    status: 'delivered', created_at: 1790000000 + i, content: `m${i}`,
  })).reverse()
  const shown = (out: string) => out.split('\n').filter((l) => l.startsWith('# msg ')).map((l) => Number(l.split(' ')[2]))

  it('(i5) ⛔ --all --limit 5 shows the newest 5 INCOMING rows, not 5 rows of both directions', () => {
    const out = render(page(10, 2), 'olvaso', 0, 5, 200)
    expect(shown(out)).toEqual([5000, 5002, 5004, 5006, 5008])
    expect(out).toContain('# 5 message(s) to olvaso')
    expect(out).not.toContain('vágva lehet')
    // Fewer asked than there are: the newest ones.
    expect(shown(render(page(10, 2), 'olvaso', 0, 3, 200))).toEqual([5004, 5006, 5008])
  })

  it('(i6) ⛔ a full page with fewer incoming rows than asked states the cut; a page that is not full does not', () => {
    const full = render(page(200, 2), 'olvaso', 0, 150, 200)
    expect(shown(full)).toHaveLength(100)
    expect(full).toContain('# a lista vágva lehet: a szerver egy lapon legfeljebb 200 sort ad')
    expect(full).toContain('100 bejövő fért el a kért 150 helyett')
    // CONTROL: the whole history fits in the page, so nothing older exists.
    expect(render(page(40, 2), 'olvaso', 0, 150, 200)).not.toContain('vágva lehet')
  })

  it('(i7) ⛔ no dashboard: rc 4 and "HTTP 000" on stderr, nothing on stdout (not a silent exit 7)', () => {
    // The script's own curl path, run on a copy that points at a closed port; the real dashboard on
    // this host must not answer the test.
    const src = readFileSync(new URL('../../scripts/agent-inbox.sh', import.meta.url), 'utf-8')
    expect(src).toContain('http://localhost:3420/api/messages')
    const dir = mkdtempSync(join(tmpdir(), 'inbox-nodash-'))
    mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'store'))
    writeFileSync(join(dir, 'scripts', 'agent-inbox.sh'), src.replaceAll('http://localhost:3420', 'http://127.0.0.1:1'), 'utf-8')
    writeFileSync(join(dir, 'store', '.dashboard-token'), 'kitalalt-token', 'utf-8')
    const r = spawnSync('bash', [join(dir, 'scripts', 'agent-inbox.sh'), 'olvaso'], { encoding: 'utf-8' })
    expect(r.status).toBe(4)
    expect(r.stderr).toContain('HTTP 000')
    expect(r.stdout).toBe('')
  })

  it('(i8) --all asks the API for one full page (limit=200) and shows the newest --limit incoming rows', async () => {
    const seen: string[] = []
    const server = createServer((req, res) => {
      seen.push(req.url ?? '')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(page(10, 2)))
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    const port = (server.address() as AddressInfo).port
    const src = readFileSync(new URL('../../scripts/agent-inbox.sh', import.meta.url), 'utf-8')
    const dir = mkdtempSync(join(tmpdir(), 'inbox-all-'))
    mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'store'))
    writeFileSync(join(dir, 'scripts', 'agent-inbox.sh'), src.replaceAll('http://localhost:3420', `http://127.0.0.1:${port}`), 'utf-8')
    writeFileSync(join(dir, 'store', '.dashboard-token'), 'kitalalt-token', 'utf-8')
    // Asynchronous: the server answers from this same process.
    const out = await new Promise<{ code: number | null; stdout: string }>((ok) => {
      const p = spawn('bash', [join(dir, 'scripts', 'agent-inbox.sh'), 'olvaso', '--all', '--limit', '5'])
      let stdout = ''
      p.stdout.on('data', (b) => { stdout += String(b) })
      p.on('close', (code) => ok({ code, stdout }))
    })
    server.close()
    expect(out.code).toBe(0)
    expect(seen).toEqual(['/api/messages?agent=olvaso&limit=200'])
    expect(shown(out.stdout)).toEqual([5000, 5002, 5004, 5006, 5008])
  })
})
