import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  snapshotPersonaFile,
  writePersonaFileIfUnchanged,
  generatedSidecarPath,
} from '../web/persona-write-guard.js'

// PERSONANOCLOBBER923. Measured on a live install, 2026-09-21: an operator
// hand-wrote an agent's CLAUDE.md and SOUL.md in the ~25 minutes between
// POST /api/agents and the end of its personality generation; generation
// failed, and the fallback wrote the "FIGYELEM: ez egy SABLON" template over
// both files. These tests pin that a completion writes only over a file that
// is still exactly what it was when generation started.

const HAND_WRITTEN = '# kezi\n\n## Tiltasok\n- Soha ne kuldj levelet jovahagyas nelkul.\n'
const GENERATED = '# generalt\n\nGeneralt szemelyiseg.\n'
const TEMPLATE = '# x\n\n> **FIGYELEM: ez egy SABLON.** A generalas nem sikerult.\n'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'persona-guard-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('persona write guard: untouched files are written', () => {
  it('absent at snapshot, still absent -> generation writes it', () => {
    const p = join(dir, 'CLAUDE.md')
    const baseline = snapshotPersonaFile(p)
    expect(baseline).toBeNull()
    const r = writePersonaFileIfUnchanged(p, baseline, GENERATED, { saveSidecarOnSkip: true })
    expect(r).toEqual({ written: true, sidecarPath: null })
    expect(readFileSync(p, 'utf8')).toBe(GENERATED)
    expect(existsSync(generatedSidecarPath(p))).toBe(false)
  })

  it('present at snapshot, byte-identical at completion -> generation overwrites it', () => {
    const p = join(dir, 'SOUL.md')
    writeFileSync(p, 'initial')
    const baseline = snapshotPersonaFile(p)
    const r = writePersonaFileIfUnchanged(p, baseline, GENERATED, { saveSidecarOnSkip: true })
    expect(r.written).toBe(true)
    expect(readFileSync(p, 'utf8')).toBe(GENERATED)
  })

  it('untouched file on the failure path -> template is written', () => {
    const p = join(dir, 'CLAUDE.md')
    const baseline = snapshotPersonaFile(p)
    const r = writePersonaFileIfUnchanged(p, baseline, TEMPLATE, { saveSidecarOnSkip: false })
    expect(r.written).toBe(true)
    expect(readFileSync(p, 'utf8')).toBe(TEMPLATE)
  })
})

describe('persona write guard: hand-edited files are never overwritten', () => {
  for (const file of ['CLAUDE.md', 'SOUL.md']) {
    it(`${file} written by hand during generation, generation SUCCEEDS -> kept, generated text saved aside`, () => {
      const p = join(dir, file)
      const baseline = snapshotPersonaFile(p)
      writeFileSync(p, HAND_WRITTEN) // the operator, mid-generation
      const r = writePersonaFileIfUnchanged(p, baseline, GENERATED, { saveSidecarOnSkip: true })
      expect(r.written).toBe(false)
      expect(readFileSync(p, 'utf8')).toBe(HAND_WRITTEN)
      expect(r.sidecarPath).toBe(join(dir, file.replace('.md', '.generated.md')))
      expect(readFileSync(r.sidecarPath!, 'utf8')).toBe(GENERATED)
    })

    it(`${file} written by hand during generation, generation FAILS -> kept, no template anywhere`, () => {
      const p = join(dir, file)
      const baseline = snapshotPersonaFile(p)
      writeFileSync(p, HAND_WRITTEN)
      const r = writePersonaFileIfUnchanged(p, baseline, TEMPLATE, { saveSidecarOnSkip: false })
      expect(r).toEqual({ written: false, sidecarPath: null })
      expect(readFileSync(p, 'utf8')).toBe(HAND_WRITTEN)
      expect(existsSync(generatedSidecarPath(p))).toBe(false)
    })
  }

  it('an existing file edited during generation (not just created) is kept too', () => {
    const p = join(dir, 'CLAUDE.md')
    writeFileSync(p, 'initial')
    const baseline = snapshotPersonaFile(p)
    writeFileSync(p, HAND_WRITTEN)
    const r = writePersonaFileIfUnchanged(p, baseline, TEMPLATE, { saveSidecarOnSkip: false })
    expect(r.written).toBe(false)
    expect(readFileSync(p, 'utf8')).toBe(HAND_WRITTEN)
  })
})

// Source-level, the idiom of agent-create-no-destructive-rollback.test.ts: the
// handler awaits real Claude CLI calls and writes into the live agents dir, so
// what is pinned is that BOTH completion paths go through the guard.
describe('POST /api/agents routes both personality writes through the guard', () => {
  const code = readFileSync(join(import.meta.dirname, '..', 'web/routes/agents.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const start = code.indexOf('scaffoldAgentDir(name)')
  const body = code.slice(start, code.indexOf('json(res, { ok: true, name })', start))

  it('no unguarded write of CLAUDE.md / SOUL.md in the create handler', () => {
    expect(start).toBeGreaterThan(-1)
    expect(body).not.toMatch(/atomicWriteFileSync\(\s*join\(\s*agentDir\(name\),\s*'(CLAUDE|SOUL)\.md'/)
    expect(body).not.toMatch(/atomicWriteFileSync\([^)]*(fallbackClaudeMd|fallbackSoulMd|claudeMd|soulMd)\)/)
  })

  it('the snapshot is taken before generation starts, and both paths use the guard', () => {
    const snap = body.indexOf('snapshotPersonaFile(')
    const gen = body.indexOf('generateClaudeMd(')
    expect(snap).toBeGreaterThan(-1)
    expect(snap).toBeLessThan(gen)
    const catchIdx = body.indexOf('} catch (err) {')
    expect(body.slice(gen, catchIdx)).toMatch(/writePersonaFileIfUnchanged\([\s\S]*saveSidecarOnSkip: true/)
    expect(body.slice(catchIdx)).toMatch(/writePersonaFileIfUnchanged\([\s\S]*saveSidecarOnSkip: false/)
  })
})
