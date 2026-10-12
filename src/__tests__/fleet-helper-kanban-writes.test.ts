// FLEETKANBAN1649 -- follow-up to #1649: fleet.py's three kanban WRITE commands
// (kanban-comment, kanban-move, kanban-set) had no test. What each part pins:
//  - the request each command sends: method, path, and the exact JSON body;
//  - the actor goes with a move AND with a set. Both routes take it out of the
//    body and hand it on (move: fireKanbanDispatch suppresses the echo only when
//    the mover is the assignee; PUT: updateKanbanCard writes it on the audit
//    event). A move without it answers {"ok":true} and costs an agent round
//    later, so the assertion is on the body, not on the answer;
//  - "-" reads the comment from stdin with newlines and non-ASCII intact, and
//    "null" clears a column;
//  - a missing argument is a usage error with exit 2 and NOTHING sent (it used
//    to be an IndexError traceback after which nothing was sent either, but the
//    caller could not tell a usage slip from a crash);
//  - the card id is one path segment.
//
// urlopen is patched, as in fleet-helper-search-carries-the-label.test.ts: the
// assertions are about what the helper sends, and a live listener would add a
// failure mode that has nothing to do with that.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'seed-skills', 'fleet-helper', 'scripts', 'fleet.py')

const HARNESS = `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("fleet", sys.argv[1])
fleet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fleet)
seen = []

class FakeResp:
    def __init__(self, body): self._b = body.encode(); self.headers = {"Content-Type": "application/json"}
    def read(self): return self._b
    def __enter__(self): return self
    def __exit__(self, *a): return False

def fake_urlopen(req, timeout=20):
    seen.append({"method": req.get_method(), "url": req.full_url,
                 "body": json.loads(req.data.decode()) if req.data else None,
                 "auth": req.get_header("Authorization")})
    return FakeResp('{"ok": true, "id": 7}')

fleet.urllib.request.urlopen = fake_urlopen
fleet.token = lambda: "test-token"
code = fleet.main(sys.argv[2:])
sys.stdout.write("\\n@@SEEN@@" + json.dumps(seen, ensure_ascii=False))
sys.exit(code)
`

function run(args: string[], stdin = '') {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-kanban-test-'))
  mkdirSync(join(dir, 'store'), { recursive: true })
  writeFileSync(join(dir, 'store', '.dashboard-token'), 'test-token\n', 'utf-8')
  const r = spawnSync('python3', ['-c', HARNESS, SCRIPT, ...args], {
    input: stdin,
    // PYTHONDONTWRITEBYTECODE: see fleet-helper-search-carries-the-label.test.ts (a .pyc in the shipped tree).
    env: { ...process.env, CLAW_DIR: dir, CLAW_BASE: 'http://127.0.0.1:1', PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf-8',
  })
  const [, seenJson] = (r.stdout ?? '').split('@@SEEN@@')
  return { code: r.status, stderr: r.stderr, seen: seenJson ? (JSON.parse(seenJson) as Array<{ method: string; url: string; body: unknown; auth: string }>) : [] }
}

describe('fleet.py kanban-comment', () => {
  it('POSTs the author and the text to the card\'s comments, with the token', () => {
    const r = run(['kanban-comment', 'CARD1', 'geri', 'Egy sor.'])
    expect(r.code).toBe(0)
    expect(r.seen).toEqual([{ method: 'POST', url: 'http://127.0.0.1:1/api/kanban/CARD1/comments', body: { author: 'geri', content: 'Egy sor.' }, auth: 'Bearer test-token' }])
  })
  it('"-" reads the text from stdin, newlines and accents intact', () => {
    const szoveg = 'Első sor: árvíztűrő\nmásodik sor `kód` és $(nem fut)\n'
    expect(run(['kanban-comment', 'CARD1', 'geri', '-'], szoveg).seen[0].body).toEqual({ author: 'geri', content: szoveg })
  })
})

describe('fleet.py kanban-move', () => {
  it('POSTs the status AND the actor (the echo suppression needs the mover)', () => {
    const r = run(['kanban-move', 'CARD1', 'in_progress', 'geri'])
    expect(r.code).toBe(0)
    expect(r.seen).toEqual([{ method: 'POST', url: 'http://127.0.0.1:1/api/kanban/CARD1/move', body: { status: 'in_progress', actor: 'geri' }, auth: 'Bearer test-token' }])
  })
})

describe('fleet.py kanban-set', () => {
  it('PUTs only the named field, with the actor for the audit event', () => {
    const r = run(['kanban-set', 'CARD1', 'due_date', '2026-10-01', 'geri'])
    expect(r.code).toBe(0)
    expect(r.seen).toEqual([{ method: 'PUT', url: 'http://127.0.0.1:1/api/kanban/CARD1', body: { due_date: '2026-10-01', actor: 'geri' }, auth: 'Bearer test-token' }])
  })
  it('"null" clears the column (JSON null, not the string)', () => {
    expect(run(['kanban-set', 'CARD1', 'due_date', 'null', 'geri']).seen[0].body).toEqual({ due_date: null, actor: 'geri' })
  })
  it('the module refuses "actor" as a field instead of letting it overwrite the argument', () => {
    const r = spawnSync('python3', ['-c', `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("fleet", sys.argv[1]); f = importlib.util.module_from_spec(spec); spec.loader.exec_module(f)
f.api = lambda *a, **k: sys.exit("SENT")
try:
    f.kanban_set("CARD1", {"actor": "valaki"}, "geri")
except ValueError as e:
    print("REFUSED", e)
`, SCRIPT], { encoding: 'utf-8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
    expect(r.stdout).toMatch(/^REFUSED actor is not a card field/)
  })
})

describe('fleet.py kanban writes: the argument edges', () => {
  it.each([
    [['kanban-comment', 'CARD1', 'geri'], 'kanban-comment <id> <author> <text|->'],
    [['kanban-move', 'CARD1', 'in_progress'], 'kanban-move <id> <status> <actor>'],
    [['kanban-set', 'CARD1', 'due_date', '2026-10-01'], 'kanban-set <id> <field> <value> <actor>'],
  ])('%j: usage, exit 2, nothing sent', (args, usage) => {
    const r = run(args as string[])
    expect(r.code).toBe(2)
    expect(r.stderr).toBe(`usage: fleet.py ${usage}\n`)
    expect(r.seen).toEqual([])
  })
  it('the card id is one path segment on all three', () => {
    for (const args of [['kanban-comment', 'a/b c', 'geri', 'x'], ['kanban-move', 'a/b c', 'done', 'geri'], ['kanban-set', 'a/b c', 'priority', 'high', 'geri']]) {
      expect(run(args).seen[0].url).toMatch(/\/api\/kanban\/a%2Fb%20c(\/|$)/)
    }
  })
})
