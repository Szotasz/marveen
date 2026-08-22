import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ISOLATED-MODE-GUARD: In IS_ISOLATED_MODE the dashboard startup must never
// write to shared project files (CLAUDE.md, agents/*/CLAUDE.md, settings.json,
// scheduled-task files). The mechanism: set WEB_ONLY=true before startWebServer()
// so all existing `!webOnly` guards in web.ts fire. Additionally ensureDefaultScheduledTasks
// must be guarded explicitly because it had no webOnly guard prior to this fix.
//
// These tests verify the guard wiring at the source level -- cheaper and more
// reliable than a full integration test that boots a real HTTP server.

const ROOT = join(__dirname, '..', '..')
const INDEX_SRC = readFileSync(join(ROOT, 'src/index.ts'), 'utf-8')
const WEB_SRC = readFileSync(join(ROOT, 'src/web.ts'), 'utf-8')

describe('ISOLATED-MODE-GUARD: index.ts sets WEB_ONLY before startWebServer in isolated mode', () => {
  it('IS_ISOLATED_MODE block sets process.env WEB_ONLY = true', () => {
    // Locate the IS_ISOLATED_MODE block
    const isolatedBlock = INDEX_SRC.match(/if\s*\(IS_ISOLATED_MODE\)\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/s)
    expect(isolatedBlock, 'IS_ISOLATED_MODE block not found in index.ts').toBeTruthy()
    const block = isolatedBlock![1]
    expect(block).toContain("process.env['WEB_ONLY'] = 'true'")
  })

  it('process.env WEB_ONLY assignment appears before startWebServer in IS_ISOLATED_MODE block', () => {
    const isolatedBlock = INDEX_SRC.match(/if\s*\(IS_ISOLATED_MODE\)\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/s)
    expect(isolatedBlock).toBeTruthy()
    const block = isolatedBlock![1]
    const webOnlyPos = block.indexOf("process.env['WEB_ONLY'] = 'true'")
    const startServerPos = block.indexOf('startWebServer(')
    expect(webOnlyPos, 'WEB_ONLY assignment not found in IS_ISOLATED_MODE block').toBeGreaterThanOrEqual(0)
    expect(startServerPos, 'startWebServer call not found in IS_ISOLATED_MODE block').toBeGreaterThanOrEqual(0)
    expect(webOnlyPos).toBeLessThan(startServerPos)
  })
})

describe('ISOLATED-MODE-GUARD: web.ts guards ensureDefaultScheduledTasks behind !webOnly', () => {
  it('ensureDefaultScheduledTasks is called only inside a !webOnly block', () => {
    // Find the call site of ensureDefaultScheduledTasks in web.ts
    // It must be preceded by an `if (!webOnly)` guard with no unconditional path
    const lines = WEB_SRC.split('\n')
    const callIdx = lines.findIndex(l => l.includes('ensureDefaultScheduledTasks()'))
    expect(callIdx, 'ensureDefaultScheduledTasks() call not found in web.ts').toBeGreaterThan(-1)

    // Walk backwards from the call to find the containing if-block opening
    // We need to see `if (!webOnly)` before seeing a closing brace
    const preceding = lines.slice(Math.max(0, callIdx - 10), callIdx).join('\n')
    expect(preceding).toMatch(/if\s*\(!webOnly\)/)
  })

  it('ensureAutonomySection is inside a !webOnly block in web.ts', () => {
    // Regression guard: must stay behind !webOnly (was already gated before this PR)
    const lines = WEB_SRC.split('\n')
    const callIdx = lines.findIndex(l => l.includes('ensureAutonomySection('))
    expect(callIdx).toBeGreaterThan(-1)
    const preceding = lines.slice(Math.max(0, callIdx - 5), callIdx).join('\n')
    expect(preceding).toMatch(/if\s*\(!webOnly\)/)
  })

  it('reconcileAgentsOnStartup is inside a !webOnly block in web.ts', () => {
    // Regression guard
    const lines = WEB_SRC.split('\n')
    const callIdx = lines.findIndex(l => l.includes('reconcileAgentsOnStartup()'))
    expect(callIdx).toBeGreaterThan(-1)
    const preceding = lines.slice(Math.max(0, callIdx - 5), callIdx).join('\n')
    expect(preceding).toMatch(/if\s*\(!webOnly\)/)
  })
})
