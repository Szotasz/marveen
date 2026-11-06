// OWNERGATE4-1104: the first-run setup is a CLOSED list. mayActAsOwner is the one strict owner gate; the shared token
// passes as the owner before the first dashboard login only through mayActAsOwnerOrFirstRun, and only for the reasons
// in FIRST_RUN_PATHS. This source scan pins every call of mayActAsOwnerOrFirstRun in src/ (tests excluded) with its
// `why`, per file, and the set of reasons used to the exported list: a new first-run caller cannot appear without
// editing both the list (auth.ts, with its reason in the JSDoc) and this pin.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as authModule from '../web/routes/auth.js'
import { FIRST_RUN_PATHS } from '../web/routes/auth.js'

const SRC = join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      out.push(...sourceFiles(p))
    } else if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.[mc]?[tj]s$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(p)
    }
  }
  return out
}

// Every call (not the definition): the argument list must end in a string literal, the reason.
function firstRunCalls(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const f of sourceFiles(SRC)) {
    const src = readFileSync(f, 'utf-8')
    for (const m of src.matchAll(/(?<!function )\bmayActAsOwnerOrFirstRun\(([^()]*)\)/g)) {
      const why = /,\s*'([a-z-]+)'\s*$/.exec(m[1]!)?.[1] ?? `<no literal reason: ${m[1]}>`
      ;(out[relative(SRC, f)] ??= []).push(why)
    }
  }
  return out
}

describe('OWNERGATE4-1104: the first-run callers are pinned', () => {
  it('FIRST_RUN_PATHS is exactly the tech lead\'s list', () => {
    expect([...FIRST_RUN_PATHS]).toEqual([
      'agent-create', 'channel-setup', 'first-pairing', 'onboarding-identity', 'onboarding-claude-auth',
      'claude-plans-login', 'first-login', 'first-device',
    ])
  })

  it('every call of mayActAsOwnerOrFirstRun, per file, with its reason', () => {
    expect(firstRunCalls()).toEqual({
      [join('web', 'routes', 'agents.ts')]: ['agent-create', 'channel-setup', 'first-pairing'],
      [join('web', 'routes', 'auth.ts')]: ['first-login', 'first-device'],
      [join('web', 'routes', 'claude-plans-login.ts')]: ['claude-plans-login'],
      [join('web', 'routes', 'onboarding.ts')]: ['onboarding-identity', 'onboarding-claude-auth'],
      [join('web', 'routes', 'security.ts')]: ['first-device'],
    })
  })

  // Review (Dani 69635, LOW): the call regex above sees only a plain, exactly named call without nested parentheses.
  // So every OTHER occurrence of the identifier outside comments must be accounted for: the definition, or a plain
  // (unaliased) import. An alias, passing the helper as a value, or a call whose arguments hold another call would
  // slip past the call pin; here they fail.
  it('every non-comment occurrence of mayActAsOwnerOrFirstRun is the definition, a plain import, or a pinned call', () => {
    const stray: string[] = []
    for (const f of sourceFiles(SRC)) {
      const src = readFileSync(f, 'utf-8')
      if (!src.includes('mayActAsOwnerOrFirstRun')) continue
      const callAt = new Set([...src.matchAll(/(?<!function )\bmayActAsOwnerOrFirstRun\(([^()]*)\)/g)].map((m) => m.index))
      let inImport = false
      let offset = 0
      for (const line of src.split('\n')) {
        const trimmed = line.trim()
        if (/^import\b/.test(trimmed) && !/\bfrom\b/.test(trimmed)) inImport = true
        const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
        const isImport = inImport || /^import\b/.test(trimmed)
        for (const m of line.matchAll(/\bmayActAsOwnerOrFirstRun\b/g)) {
          const at = offset + m.index!
          if (isComment) continue
          if (/\bmayActAsOwnerOrFirstRun\s+as\b/.test(line.slice(m.index!))) { stray.push(`${relative(SRC, f)}: alias: ${trimmed}`); continue }
          if (isImport) continue
          if (/function\s+$/.test(line.slice(0, m.index!))) continue
          if (callAt.has(at)) continue
          stray.push(`${relative(SRC, f)}: ${trimmed}`)
        }
        if (inImport && /\bfrom\b/.test(trimmed)) inImport = false
        offset += line.length + 1
      }
    }
    expect(stray).toEqual([])
  })

  // Review (Dani 69718, LOW): noPlanExistsYet reads the vault from its own copy of the path (vault.ts keeps VAULT_PATH
  // unexported, and tests stub vault.js). If the two drifted, the plan-login check would read a missing file as "no
  // plan" and OPEN the first-run path (fail-open). So the two definitions are pinned to the same expression.
  it('the plan-login first-run check reads the vault from the same path vault.ts writes', () => {
    const vaultDef = /const VAULT_PATH = (join\(PROJECT_ROOT, 'store', 'vault\.json'\))/.exec(readFileSync(join(SRC, 'web', 'vault.ts'), 'utf-8'))
    const loginDef = /const VAULT_FILE = (join\(PROJECT_ROOT, 'store', 'vault\.json'\))/.exec(readFileSync(join(SRC, 'web', 'routes', 'claude-plans-login.ts'), 'utf-8'))
    expect(vaultDef?.[1]).toBeDefined()
    expect(loginDef?.[1]).toBe(vaultDef?.[1])
  })

  it('the set of reasons used equals FIRST_RUN_PATHS (no unused entry, no reason off the list)', () => {
    const used = new Set(Object.values(firstRunCalls()).flat())
    expect([...used].sort()).toEqual([...FIRST_RUN_PATHS].sort())
  })

  it('the first pairing keeps its "no approved sender yet" condition at the call site', () => {
    const agents = readFileSync(join(SRC, 'web', 'routes', 'agents.ts'), 'utf-8')
    expect(agents).toContain('const firstPairing = channelHasNoApprovedSender(chDir)')
    expect(agents).toContain("firstPairing ? mayActAsOwnerOrFirstRun(ctx.auth, req, 'first-pairing') : mayActAsOwner(ctx.auth, req)")
  })

  it('the plan login keeps its paired-Bridge-key alternative (and its "target plan has no credential" condition)', () => {
    const src = readFileSync(join(SRC, 'web', 'routes', 'claude-plans-login.ts'), 'utf-8')
    expect(src).toContain("(firstLogin ? mayActAsOwnerOrFirstRun(ctx.auth, req, 'claude-plans-login') : mayActAsOwner(ctx.auth, req)) && !isPairedBridgeKey(ctx.auth)")
  })

  // OWNERGATE4-1104 (review, Samu 69637): three more paths are open only while the thing they write is still empty.
  it('channel setup, the Claude credential and the plan login keep their "still empty" condition at the call site', () => {
    const agents = readFileSync(join(SRC, 'web', 'routes', 'agents.ts'), 'utf-8')
    expect(agents).toContain('const firstSetup = channelIsUnconfigured(setupChDir)')
    expect(agents).toContain("firstSetup ? mayActAsOwnerOrFirstRun(ctx.auth, req, 'channel-setup') : mayActAsOwner(ctx.auth, req)")
    const onboarding = readFileSync(join(SRC, 'web', 'routes', 'onboarding.ts'), 'utf-8')
    expect(onboarding).toContain('const firstCredential = await noClaudeCredentialYet()')
    expect(onboarding).toContain("firstCredential ? mayActAsOwnerOrFirstRun(ctx.auth, req, 'onboarding-claude-auth') : mayActAsOwner(ctx.auth, req)")
    const plans = readFileSync(join(SRC, 'web', 'routes', 'claude-plans-login.ts'), 'utf-8')
    expect(plans).toContain('const firstLogin = noPlanExistsYet()')
  })

  it('mayIssueCredentials and mayActAsOwnerStrict are not exported, and nothing in src calls them', () => {
    expect('mayIssueCredentials' in authModule).toBe(false)
    expect('mayActAsOwnerStrict' in authModule).toBe(false)
    const callers = sourceFiles(SRC).filter((f) => /\b(?:mayIssueCredentials|mayActAsOwnerStrict)\(/.test(readFileSync(f, 'utf-8')))
    expect(callers.map((f) => relative(SRC, f))).toEqual([])
  })
})
