// VERZIOTORLES1009: the agent-id-header section ships to every agent's CLAUDE.md.
// It used to say that a DELETE also keeps the previous content as a version.
// deleteMemoryById (src/db.ts) removes the versions with the row on purpose
// (#1357), so the sentence was false, and a customer deleted 84 rows trusting it.
//
// The text is tied to the behaviour from the source: if a later change makes a
// delete keep its versions, this test fails and the sentence must change with it.
// The functional part mirrors message-close-section.test.ts (temp root, mocked
// config): an already installed section with the old sentence is replaced.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-agentid-test-'))

vi.mock('../config.js', () => ({
  STORE_DIR: '/nonexistent/claudeclaw-test-store',
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

const { ensureAgentIdHeaderSection, buildAgentIdHeaderBody } = await import('../web/agent-scaffold.js')

const BEGIN = '<!-- BEGIN GENERATED: agent-id-header (auto-generated, do not edit by hand) -->'
const END = '<!-- END GENERATED: agent-id-header -->'
const OLD_CLAIM = 'minden felülírás és törlés előtt eltárolódik az előző tartalom'

const here = dirname(fileURLToPath(import.meta.url))
const dbSrc = readFileSync(join(here, '..', 'db.ts'), 'utf-8')
const deleteFn = dbSrc.slice(dbSrc.indexOf('export function deleteMemoryById'), dbSrc.indexOf('\n}\n', dbSrc.indexOf('export function deleteMemoryById')))

describe('agent-id-header: what it says about delete and versions (VERZIOTORLES1009)', () => {
  const body = buildAgentIdHeaderBody('agent-b')

  it('the behaviour it describes: deleteMemoryById removes the versions with the row', () => {
    expect(deleteFn).toContain("DELETE FROM memory_versions WHERE memory_id = ?")
  })

  it('no longer promises that a delete keeps the previous content', () => {
    expect(body).not.toContain(OLD_CLAIM)
    expect(body).not.toMatch(/törlés előtt eltárolódik/)
  })

  it('says that versions exist for an overwrite, and that a delete is final and takes them', () => {
    expect(body).toMatch(/felülírás előtt eltárolódik[\s\S]{0,80}\/versions/)
    expect(body).toMatch(/TÖRLÉS viszont VÉGLEGES/)
    expect(body).toMatch(/verzióit is törli/)
    expect(body).toMatch(/így utána semmiből nem állítható vissza/)
  })

  it('tells the reader to read the row out before a delete, with the read endpoint', () => {
    expect(body).toMatch(/előtte olvasd ki[\s\S]{0,60}GET \/api\/memories\/<id>`/)
  })
})

describe('agent-id-header: an installed section with the old sentence is replaced', () => {
  it('rewrites the generated block in place and keeps the rest of the file', () => {
    const dir = join(tmpRoot, 'agents', 'agent-b')
    mkdirSync(dir, { recursive: true })
    const old = `# Agent B\n\nkézi szöveg\n\n${BEGIN}\nrégi szöveg: ${OLD_CLAIM}\n${END}\n\nutána is kézi\n`
    writeFileSync(join(dir, 'CLAUDE.md'), old, 'utf-8')

    ensureAgentIdHeaderSection('agent-b')
    const after = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')

    expect(after).not.toContain(OLD_CLAIM)
    expect(after).toContain('TÖRLÉS viszont VÉGLEGES')
    expect(after.startsWith('# Agent B\n\nkézi szöveg\n\n')).toBe(true)
    expect(after).toContain('\n\nutána is kézi\n')
    expect(after.split(BEGIN).length - 1).toBe(1)

    ensureAgentIdHeaderSection('agent-b')
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toBe(after)
  })
})
