import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The consumer half. Putting the freshness signal in the API response is only
// half the fix: `scripts/agent-msg-get.sh` is the reader the
// system itself points agents at (the completion notification names it by
// command, and the system-directive rule tells recipients to fetch
// /api/messages/<N>), and it renders a HAND-PICKED set of fields. A new field
// the renderer does not know about is a field the reader never sees.
//
// This runs the script's actual rendering block against a fixture response
// instead of grepping the file for the word "freshness" -- the check is what
// the reader SEES, not what the source contains.
function render(response: unknown): string {
  const script = readFileSync(new URL('../../scripts/agent-msg-get.sh', import.meta.url), 'utf-8')
  const m = script.match(/python3 - "\$OUT" <<'PY'\n([\s\S]*?)\nPY/)
  expect(m, 'the python rendering block must still be recognizable').not.toBeNull()

  const dir = mkdtempSync(join(tmpdir(), 'msgget-'))
  const py = join(dir, 'render.py')
  const json = join(dir, 'msg.json')
  writeFileSync(py, m![1], 'utf-8')
  writeFileSync(json, JSON.stringify(response), 'utf-8')
  return execFileSync('python3', [py, json], { encoding: 'utf-8' })
}

const base = {
  id: 4242, from_agent: 'marveen', to_agent: 'olvaso', status: 'pending',
  content: 'Az utasitas torzse.', result: null,
}

describe('agent-msg-get.sh shows the freshness note it is now served', () => {
  it('prints a supersession warning ABOVE the content', () => {
    const note = '[!FRISSESSEG (13p regi): azota 2 ujabb uzenet erkezett ugyanettol a kuldotol'
      + ' -- lehet ELAVULT/felulirt; ellenorizd id-sorrendben mielott cselekszel]'
    const out = render({ ...base, freshness: { ageMinutes: 13, newerFromSameSender: 2, note } })

    expect(out).toContain(note)
    // Above, because a warning printed under a long body is one nobody reads.
    expect(out.indexOf(note)).toBeLessThan(out.indexOf('--- CONTENT ---'))
    expect(out).toContain('Az utasitas torzse.')
  })

  it('prints nothing extra for fresh traffic (empty note)', () => {
    const out = render({ ...base, freshness: { ageMinutes: 0, newerFromSameSender: 0, note: '' } })
    expect(out).not.toContain('!!')
    expect(out).toContain('--- CONTENT ---')
  })

  it('still renders when the field is absent -- an older server, or a 404-shaped body', () => {
    const out = render(base)
    expect(out).toContain('Az utasitas torzse.')
    expect(out).toContain('# msg 4242  marveen -> olvaso  status=pending')
  })
})
