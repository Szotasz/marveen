import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The agent package modules decide from their inputs only: no environment
// switch and no test-run switch may change what they accept. PR-I1 is also
// pure (plan 5): the verifier and the key list touch no network and no disk;
// node:crypto is their only built-in import.

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..')
const DIR = join(SRC, 'web', 'agent-package')
const ROUTE_FILE = join(SRC, 'web', 'routes', 'agent-packages.ts')
const sources = [
  ...readdirSync(DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => [f, readFileSync(join(DIR, f), 'utf8')] as const),
  // PR-I2: the route file is under the same rule (plan 5.2).
  ['routes/agent-packages.ts', readFileSync(ROUTE_FILE, 'utf8')] as const,
]

/** Every .ts under src/ outside __tests__, as [path relative to src, text]. */
function srcFiles(dir = SRC, rel = ''): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name === 'node_modules') continue
    const p = join(dir, e.name)
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...srcFiles(p, r))
    else if (e.name.endsWith('.ts')) out.push([r, readFileSync(p, 'utf8')])
  }
  return out
}
const ALL_SRC = srcFiles()

describe('src/web/agent-package source scan', () => {
  it('finds the modules', () => {
    expect(sources.map(([f]) => f).sort()).toEqual(expect.arrayContaining(['frontmatter.ts', 'keys.ts', 'verify.ts', 'remote.ts', 'routes/agent-packages.ts']))
  })

  it.each(sources)('%s reads no environment variable and no test-run switch', (_f, src) => {
    expect(src).not.toMatch(/process\s*\.\s*env/)
    expect(src).not.toMatch(/process\s*\[/)
    expect(src).not.toMatch(/isTestRun/)
  })

  it.each(sources.filter(([f]) => ['verify.ts', 'keys.ts', 'frontmatter.ts'].includes(f)))(
    '%s imports nothing but node:crypto and its siblings, and calls no fetch',
    (_f, src) => {
      const specifiers = [...src.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1])
      for (const s of specifiers) expect(s === 'node:crypto' || /^\.\/[a-z-]+\.js$/.test(s)).toBe(true)
      expect(src).not.toMatch(/\bimport\s*\(/)
      expect(src).not.toMatch(/\brequire\s*\(/)
      expect(src).not.toMatch(/\bfetch\s*\(/)
    },
  )
})

// PR-I2 (plan 5.2, 6.4; mutant rows 11 and 45): the released build is what web.ts wires, and the token stays in
// remote.ts.
describe('the released build and the credential (PR-I2)', () => {
  const route = readFileSync(ROUTE_FILE, 'utf8')
  const web = readFileSync(join(SRC, 'web.ts'), 'utf8')

  it('web.ts calls the handler with ONE argument, before tryHandleAgentsSkills', () => {
    const calls = [...web.matchAll(/tryHandleAgentPackages\(([^)]*)\)/g)].map((m) => m[1])
    expect(calls).toEqual(['routeCtx'])
    expect(web.indexOf('tryHandleAgentPackages(routeCtx)')).toBeLessThan(web.indexOf('tryHandleAgentsSkills(routeCtx)'))
    expect(web.indexOf('tryHandleAgentPackages(routeCtx)')).toBeGreaterThan(-1)
  })

  it('makeRemote( is called outside remote.ts only in RELEASED_DEPS', () => {
    const block = route.match(/export const RELEASED_DEPS: PackageDeps = \{[\s\S]*?\n\}/)
    expect(block).not.toBeNull()
    expect(block![0]).toContain('remote: makeRemote(PACKAGE_ORIGIN)')
    expect(block![0].split('makeRemote(').length - 1).toBe(1)
    const callers = ALL_SRC.filter(([f, t]) => f !== 'web/agent-package/remote.ts' && t.includes('makeRemote(')).map(([f, t]) => [f, t.split('makeRemote(').length - 1])
    expect(callers).toEqual([['web/routes/agent-packages.ts', 1]])
  })

  it('the route handler calls the network through deps.remote only', () => {
    const head = route.indexOf('export async function tryHandleAgentPackages(ctx: RouteContext, deps: PackageDeps = RELEASED_DEPS)')
    expect(head).toBeGreaterThan(-1)
    const handler = route.slice(route.indexOf('{', head))
    expect(handler).toMatch(/deps\.remote\.redeem\(/)
    expect(handler).toMatch(/deps\.remote\.catalog\(/)
    expect(handler).not.toMatch(/RELEASED_DEPS|makeRemote|\bfetch\s*\(/)
  })

  it('the credential file name appears in remote.ts and, as a name only, in the store watcher\'s two lists', () => {
    const NAME = 'agent-package-credential'
    const holders = ALL_SRC.filter(([, t]) => t.includes(NAME)).map(([f]) => f).sort()
    expect(holders).toEqual(['store-watcher.ts', 'web/agent-package/remote.ts'])
    const watcher = ALL_SRC.find(([f]) => f === 'store-watcher.ts')![1]
    const sets = ['SYSTEM_FILES', 'SENSITIVE_NAMES'].map((n) => watcher.match(new RegExp(`const ${n} = new Set\\(\\[[\\s\\S]*?\\]\\)`))?.[0] ?? '')
    for (const set of sets) expect(set).toContain(`'${NAME}.json'`)
    expect(watcher.split(NAME).length - 1).toBe(2)
  })

  it('remote.ts exports exactly its known surface (a new export, such as a token getter, is a deliberate edit here)', async () => {
    const m = await import('../web/agent-package/remote.js')
    expect(Object.keys(m).sort()).toEqual([
      'CATALOG_MAX_BYTES', 'ERROR_BODY_MAX_BYTES', 'PACKAGE_ORIGIN', 'REDEEM_TIMEOUT_MS', 'REQUEST_TIMEOUT_MS',
      'deleteCredential', 'makeRemote', 'readCredentialView', 'refusalFor', 'removeCredentialTmpLeftovers', 'transportRefusal',
    ])
  })

  it('the released origin is empty until the host is decided (N3)', async () => {
    const m = await import('../web/agent-package/remote.js')
    expect(m.PACKAGE_ORIGIN).toBe('')
  })

  it('index.ts removes the credential tmp leftovers at startup, after the database and before the web server', () => {
    const index = readFileSync(join(SRC, 'index.ts'), 'utf8')
    const at = index.indexOf('removeCredentialTmpLeftovers()')
    expect(at).toBeGreaterThan(index.indexOf('initDatabase()'))
    expect(at).toBeLessThan(index.indexOf('startWebServer(WEB_PORT)'))
  })
})
