// CURLQUOTE910: the generator must not hand agents a curl form whose payload the
// shell expands. In a double-quoted `-d "{...}"` the shell runs backticks and
// $(...) INSIDE the payload and substitutes the output, so a report that quotes a
// filename, a hash, or -- worse -- a stranger's message text executes it, and the
// POST still returns 200. Nothing marks the loss on either end, which is why the
// shape is pinned by tests instead of by care: a reader copying the block cannot
// tell a working example from a hazardous one by looking at it.
//
// Two generated surfaces carry a curl example into every agent's CLAUDE.md:
//   1. buildAutonomyBody()  -- rewritten on EVERY agent start (ensureAutonomySection)
//   2. generateClaudeMd()   -- written once, at agent creation (stranger-sender rule)
// Both are asserted here: (1) functionally, on the file the generator writes, and
// (2) at source level, the established idiom for the LLM-calling generator.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-curlquote-test-'))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  AGENT_API_ORIGIN: '',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(tmpRoot, 'agents', name),
  agentConfigRoot: () => join(tmpRoot, 'agents'),
  listAgentNames: () => ['agent-a', 'agent-b'],
  readAgentCapabilities: () => [],
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { ensureAutonomySection } = await import('../web/agent-scaffold.js')

const MARKER_BEGIN = '<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->'
const MARKER_END = '<!-- END GENERATED: autonomy-wiring -->'

// A payload the shell expands: -d / --data followed by a double quote.
const SHELL_EXPANDING_PAYLOAD = /(?:^|\s)(?:-d|--data|--data-raw)\s+"/

function writtenAutonomyBlock(agentName: string): string {
  const dir = join(tmpRoot, 'agents', agentName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), `# ${agentName}\n`, 'utf-8')
  ensureAutonomySection(agentName)
  const file = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')
  const from = file.indexOf(MARKER_BEGIN)
  const to = file.indexOf(MARKER_END)
  expect(from, 'autonomy block not written').toBeGreaterThanOrEqual(0)
  expect(to, 'autonomy end marker not written').toBeGreaterThan(from)
  return file.slice(from, to)
}

describe('generated autonomy block: no shell-expanding curl payload', () => {
  it('the measure is not vacuous -- the written block really carries curl examples', () => {
    const block = writtenAutonomyBlock('meter-check-agent')
    const curlLines = block.split('\n').filter((l) => l.trimStart().startsWith('curl '))
    expect(curlLines.length).toBeGreaterThanOrEqual(2)
  })

  // Positive control: the level 2 approvals example has ALWAYS used a single-quoted
  // payload. It must pass the same measure today, before any fix -- a meter that
  // cannot see the correct form is blind to the broken one.
  it('positive control: the level 2 approvals example passes the measure', () => {
    const block = writtenAutonomyBlock('control-agent')
    const level2 = block.slice(block.indexOf('Level 2'))
    const approvals = level2.split('\n').find((l) => l.includes('/api/approvals') && l.includes('POST'))
    expect(approvals, '/api/approvals POST example not found').toBeTruthy()
    expect(approvals!).not.toMatch(SHELL_EXPANDING_PAYLOAD)
    expect(approvals!).toContain(`-d '`)
  })

  it('the level 1 inter-agent example does not use a double-quoted payload', () => {
    const block = writtenAutonomyBlock('level1-agent')
    const level1 = block.slice(block.indexOf('Level 1'), block.indexOf('Level 2'))
    expect(level1).toContain('/api/messages')
    expect(level1).not.toMatch(SHELL_EXPANDING_PAYLOAD)
  })

  it('no line of the whole generated block uses a double-quoted payload', () => {
    const block = writtenAutonomyBlock('whole-block-agent')
    const offenders = block.split('\n').filter((l) => SHELL_EXPANDING_PAYLOAD.test(l))
    expect(offenders, `shell-expanding payload in generated block:\n${offenders.join('\n')}`).toEqual([])
  })

  it('the level 1 example ships the quoted-heredoc form, so free text stays inert', () => {
    const block = writtenAutonomyBlock('heredoc-agent')
    const level1 = block.slice(block.indexOf('Level 1'), block.indexOf('Level 2'))
    expect(level1).toContain(`--data-binary @- <<'JSON'`)
  })
})

describe('generateClaudeMd source: no shell-expanding curl payload', () => {
  const src = readFileSync(join(process.cwd(), 'src/web/agent-scaffold.ts'), 'utf-8')
  const fnStart = src.indexOf('export async function generateClaudeMd')
  const fnEnd = src.indexOf('export async function generateSoulMd')

  it('the measure is not vacuous -- the generator body is found and carries curl examples', () => {
    expect(fnStart, 'generateClaudeMd not found').toBeGreaterThan(0)
    expect(fnEnd, 'generateSoulMd terminator not found').toBeGreaterThan(fnStart)
    expect(src.slice(fnStart, fnEnd)).toContain('curl -s -X POST')
  })

  // The stranger-sender ARANYSZABÁLY example interpolates a stranger's own words
  // into the payload. That is the one place a double-quoted payload is not a style
  // question: the stranger writes the command that runs.
  it('the stranger-sender example does not use a double-quoted payload', () => {
    const body = src.slice(fnStart, fnEnd)
    const offenders = body.split('\n').filter((l) => SHELL_EXPANDING_PAYLOAD.test(l))
    expect(offenders, `shell-expanding payload in generateClaudeMd:\n${offenders.join('\n')}`).toEqual([])
  })
})
