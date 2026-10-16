// MEMKERESVAK917 -- fleet.py's search_memory() used to return the response body
// and drop r.headers on the floor. The memory search is deliberately forgiving:
// when nothing matches the query as asked it answers with whatever the leftover
// filler words pulled in, and in the BODY that is byte-indistinguishable from a
// real hit. The only thing that separates them is the X-Memory-Search header.
//
// A curl recipe can at least be told to add `-D`. A Python helper cannot: the
// caller has no seam to opt in through, so dropping the header there is a
// harder blindness than the one #1380 fixed. This pins that the helper hands
// the label back, that a rescue is ANNOUNCED rather than merely available, and
// that the URL it builds carries strict/limit where those matter.
//
// urlopen is patched rather than a real socket opened: the assertions are about
// what the helper does with the response and what URL it asks for, and a live
// listener would add a failure mode that has nothing to do with either.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'seed-skills', 'fleet-helper', 'scripts', 'fleet.py')

const HARNESS = `
import json, sys, importlib.util, types
spec = importlib.util.spec_from_file_location("fleet", sys.argv[1])
fleet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fleet)

label = sys.argv[2]
rows = json.loads(sys.argv[3])
seen = {}

class FakeResp:
    def __init__(self, body, headers):
        self._b = body.encode()
        # urllib gives a case-insensitive message object; a plain dict with the
        # canonical casing is the harsher stand-in, since the helper must not
        # depend on exact case.
        self.headers = headers
    def read(self): return self._b
    def __enter__(self): return self
    def __exit__(self, *a): return False

def fake_urlopen(req, timeout=20):
    seen["url"] = req.full_url
    hdrs = {"Content-Type": "application/json"}
    if label:
        hdrs["X-Memory-Search"] = label
    return FakeResp(json.dumps(rows), hdrs)

fleet.urllib.request.urlopen = fake_urlopen
fleet.token = lambda: "test-token"

kwargs = json.loads(sys.argv[4])
out = fleet.search_memory(**kwargs)
print(json.dumps({"url": seen.get("url"), "out": out}, ensure_ascii=False))
`

function run(label: string, rows: unknown[], kwargs: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-helper-test-'))
  mkdirSync(join(dir, 'store'), { recursive: true })
  writeFileSync(join(dir, 'store', '.dashboard-token'), 'test-token\n', 'utf-8')
  const stdout = execFileSync(
    'python3',
    ['-c', HARNESS, SCRIPT, label, JSON.stringify(rows), JSON.stringify(kwargs)],
    // PYTHONDONTWRITEBYTECODE: fleet.py lives under seed-skills/, a SHIPPED
    // template tree. Without this, importing it writes __pycache__/*.pyc into
    // that tree, and template-identity-hygiene.test.ts -- which walks the same
    // tree and reads every file as utf-8 -- then reports the decoded bytes as a
    // hardcoded absolute home path. The suite fails on its own artifact, and
    // only when this file happens to run first, so it reads as a flake.
    {
      env: { ...process.env, CLAW_DIR: dir, CLAW_BASE: 'http://127.0.0.1:1', PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf-8',
    },
  )
  return JSON.parse(stdout) as { url: string; out: Record<string, unknown> }
}

describe('fleet.py search_memory', () => {
  it('hands back the raw label alongside the rows', () => {
    const { out } = run('strict=false; relaxed=false; hits=2', [{ id: 1 }, { id: 2 }], { agent: 'agent-a', q: 'kanban' })
    expect(out.label).toBe('strict=false; relaxed=false; hits=2')
    expect(out.relaxed).toBe(false)
    expect(out.hits).toBe(2)
    expect(out.rows).toHaveLength(2)
  })

  it('announces a rescue instead of leaving it to be noticed', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i }))
    const { out } = run('strict=false; relaxed=true; hits=50', rows, { agent: 'agent-a', q: 'sosem-letezett' })
    expect(out.relaxed).toBe(true)
    expect(String(out.warning)).toMatch(/relaxed=true/)
    expect(String(out.warning)).toMatch(/strict=1/)
  })

  // The hybrid branch of the endpoint sends a DIFFERENT header shape, with no
  // strict= field at all. Reading the label by substring rather than by
  // position is what makes both work.
  it('reads the hybrid header shape too', () => {
    const { out } = run('fts=0; vector=12; relaxed=true; vector-only=true', [], { agent: 'agent-a', q: 'barmi' })
    expect(out.relaxed).toBe(true)
    expect(out.warning).toBeTruthy()
  })

  it('reports no rescue when the endpoint sent no label at all', () => {
    const { out } = run('', [{ id: 1 }], { agent: 'agent-a', q: 'barmi' })
    expect(out.label).toBe('')
    expect(out.relaxed).toBe(false)
    expect(out.warning).toBeUndefined()
  })

  it('passes strict=1 through, which is what an absence claim needs', () => {
    const { url, out } = run('strict=true; relaxed=false; hits=0', [], { agent: 'agent-a', q: 'barmi', strict: true })
    expect(url).toContain('strict=1')
    expect(out.strict).toBe(true)
    expect(out.hits).toBe(0)
  })

  // This used to assert the opposite -- that a category search asks for
  // limit=200 -- because the tier filter ran AFTER the limit and truncated in
  // silence. #1384 pushed the filter into the search SQL, measured on merged
  // develop against a copy of the owner store: q=billingo&category=warm now
  // answers 39 rows at limit=50 and 39 at limit=200, where before it was 9 and
  // 39. So the workaround is gone, and what is pinned instead is that this
  // helper does not quietly use a different page size from every other caller.
  it('passes the category through without inventing a page size', () => {
    const { url } = run('strict=false; relaxed=false; hits=1', [{ id: 1 }], { agent: 'agent-a', q: 'billingo', category: 'warm' })
    expect(url).toContain('category=warm')
    expect(url).not.toContain('limit=')
  })

  it('asks for no page size without a filter either', () => {
    const { url } = run('strict=false; relaxed=false; hits=1', [{ id: 1 }], { agent: 'agent-a', q: 'billingo' })
    expect(url).not.toContain('limit=')
  })
})
