// The schedule section of the CLAUDE.md that generateClaudeMd() writes for a new
// sub-agent must teach only what the sub-agent self-pace gate lets through
// (#1999 review): no schedule write of any kind, and the one accepted read form,
// `curl -q -s -H "Authorization: Bearer $(cat <absolute token path>)" <origin>/api/schedules`.
// The section is read from the source (no LLM call), the taught command is
// rendered with a disposable project root, and the real gateDecision judges it.
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dirname, '..', 'web', 'agent-scaffold.ts'), 'utf-8')
const start = src.indexOf('export async function generateClaudeMd')
const end = src.indexOf('export async function generateSoulMd')
const prompt = src.slice(start, end)
const secStart = prompt.indexOf('## Ütemezett feladatok')
const secEnd = prompt.indexOf('\n## ', secStart + 5)
const section = prompt.slice(secStart, secEnd)

const ROOT = mkdtempSync(join(tmpdir(), 'sched-section-root-'))
mkdirSync(join(ROOT, 'store'), { recursive: true })
mkdirSync(join(ROOT, 'agents', 'agent-a'), { recursive: true })
writeFileSync(join(ROOT, 'store', '.dashboard-token'), 'example-token_0123\n')
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))
const OPTS = { projectRoot: ROOT, selfAgent: 'agent-a' }
const render = (line: string) => line
  .replaceAll('${tokenPath}', join(ROOT, 'store', '.dashboard-token'))
  .replaceAll('${dashboardOrigin}', 'http://localhost:3420')
  .replaceAll('AGENT_NAME', 'agent-a')
const denied = (command: string) => gateDecision('Bash', { command }, OPTS).deny

describe('generateClaudeMd: the schedule section matches the self-pace gate', () => {
  it('the section exists inside the generateClaudeMd prompt', () => {
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    expect(secStart).toBeGreaterThan(0)
    expect(secEnd).toBeGreaterThan(secStart)
  })

  it('teaches no schedule write, and routes create/change through the main agent', () => {
    expect(section).not.toMatch(/-X\s*(POST|PUT|PATCH|DELETE)/)
    expect(section).not.toMatch(/\s-d\s|--data/)
    expect(section).toContain('${MAIN_AGENT_ID}')
    expect(section).toMatch(/NEM hozhatsz létre/)
  })

  it('every taught curl is the accepted GET form, and the gate allows it for a sub-agent', () => {
    const curls = section.split('\n').filter((l) => l.startsWith('curl '))
    expect(curls).toEqual(['curl -q -s -H "Authorization: Bearer $(cat ${tokenPath})" ${dashboardOrigin}/api/schedules'])
    for (const c of curls) expect(denied(render(c))).toBe(false)
  })

  it('the form taught before this change is denied by the gate (why the text had to change)', () => {
    const old = 'curl -s -X POST ${dashboardOrigin}/api/schedules -H "Content-Type: application/json" -H "Authorization: Bearer $(cat ${tokenPath})" -d \'{"name": "feladat-nev", "description": "Rövid leírás", "prompt": "A részletes prompt", "schedule": "0 8 * * *", "agent": "AGENT_NAME", "type": "heartbeat"}\''
    expect(denied(render(old))).toBe(true)
    // and the GET without -q first, which the old text implied, is denied too
    expect(denied(render('curl -s -H "Authorization: Bearer $(cat ${tokenPath})" ${dashboardOrigin}/api/schedules'))).toBe(true)
  })

  it('the deny message hint holds: a document that mentions the API goes through the native Write tool, not a heredoc', () => {
    const doc = 'Notes: the runner lists GET /api/schedules and reads ~/.claude/scheduled-tasks/.\n'
    expect(gateDecision('Write', { file_path: join(ROOT, 'notes', 'review.md'), content: doc }, OPTS).deny).toBe(false)
    expect(denied(`cat <<'EOF' > ${join(ROOT, 'notes', 'review.md')}\n${doc}EOF`)).toBe(true)
  })
})
