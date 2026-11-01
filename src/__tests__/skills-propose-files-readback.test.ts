// SKILLSPLIT1101 (Dani 65108): after writing a proposed reference file, queueProposedSkill reads it back without
// following links. A normal run cannot put a link there (a live skill with one is refused before the copy), so the
// write itself is replaced here: it leaves a symlink where the file should be, as a race would.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'skills-readback-home-'))
const tmpRoot = mkdtempSync(join(tmpdir(), 'skills-readback-root-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome
afterAll(() => { process.env.HOME = realHome; rmSync(tmpHome, { recursive: true, force: true }); rmSync(tmpRoot, { recursive: true, force: true }) })

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store'), MAIN_AGENT_ID: 'host-main',
}))
// The link target is a file of this test, never a system file.
const linkTarget = join(tmpRoot, 'outside.md')
vi.mock('../web/atomic-write.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/atomic-write.js')>()
  return {
    ...real,
    atomicWriteFileSync: (path: string, data: string | Buffer, ...rest: unknown[]) => {
      if (path.endsWith(join('references', 'raced.md'))) { writeFileSync(linkTarget, 'outside'); symlinkSync(linkTarget, path); return }
      return (real.atomicWriteFileSync as (...a: unknown[]) => unknown)(path, data, ...rest)
    },
  }
})

const q = await import('../web/skill-quarantine.js')

describe('the read-back after a proposed file is written', () => {
  it('a link where the file should be: refused, and the pending entry is removed', () => {
    const r = q.queueProposedSkill('raced-skill', '---\nname: raced-skill\n---\n', { files: [{ path: 'references/ok.md', content: 'x' }, { path: 'references/raced.md', content: 'x' }] })
    expect(r).toMatchObject({ ok: false, status: 400 })
    let ids: string[] = []
    try { ids = readdirSync(join(tmpRoot, 'store', 'skills-pending')) } catch { /* none */ }
    expect(ids).toEqual([])
  })
})
