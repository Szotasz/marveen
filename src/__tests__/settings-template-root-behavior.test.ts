import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// The loud error for a project root the settings template cannot carry, exercised on the
// real functions with a root that contains a dollar sign. The source-text checks in settings-template-root.test.ts say
// where the assert is; this says what it DOES: nothing is created before the refusal, the render throws, and
// ensureAgentHooks logs at error level instead of dropping the hooks silently.

const st = vi.hoisted(() => ({ root: '', proj: '', logged: [] as unknown[][] }))

vi.mock('../config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config.js')>()
  return { ...original, PROJECT_ROOT: st.proj, STORE_DIR: `${st.proj}/store` }
})
vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(st.root, 'agents', name),
  agentConfigRoot: () => join(st.root, 'agents'),
  listAgentNames: () => ['agent-a'],
  readAgentCapabilities: () => [],
}))
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))
vi.mock('../logger.js', () => {
  const quiet = (): unknown => new Proxy(() => undefined, { get: () => quiet, apply: () => undefined })
  const logger = new Proxy({}, {
    get: (_t, key) => (key === 'error' ? (...args: unknown[]) => { st.logged.push(args) } : quiet),
  })
  return { logger }
})

let scaffold: typeof import('../web/agent-scaffold.js')

beforeAll(async () => {
  st.root = mkdtempSync(join(tmpdir(), 'marveen-settings-root-'))
  st.proj = join(st.root, 'pro$ject')
  mkdirSync(join(st.proj, 'templates'), { recursive: true })
  writeFileSync(join(st.proj, 'templates', 'settings.json.template'), JSON.stringify({ hooks: { Stop: [] } }))
  scaffold = await import('../web/agent-scaffold.js')
})

afterAll(() => {
  if (st.root) rmSync(st.root, { recursive: true, force: true })
})

describe('a project root with a dollar sign: the settings template refuses loudly', () => {
  it('renderSettingsTemplate throws a named error', () => {
    expect(() => scaffold.renderSettingsTemplate('{}')).toThrowError(/settings\.json\.template: the project root .* contains "\$"/)
  })

  it('scaffoldAgentDir throws before it creates anything (no half-built agent, no 409 on the retry)', () => {
    const dir = join(st.root, 'agents', 'agent-new')
    expect(() => scaffold.scaffoldAgentDir('agent-new')).toThrowError(/settings\.json\.template/)
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(join(st.root, 'agents'))).toBe(false)
  })

  it('ensureAgentHooks returns false AND logs the failure at error level', () => {
    const before = st.logged.length
    expect(scaffold.ensureAgentHooks('agent-a')).toBe(false)
    const fresh = st.logged.slice(before)
    expect(fresh.length, 'nothing was logged: the hooks were dropped silently').toBeGreaterThan(0)
    expect(JSON.stringify(fresh)).toMatch(/settings\.json\.template not rendered; hooks NOT registered/)
    expect(JSON.stringify(fresh)).toMatch(/project root/)
  })
})
