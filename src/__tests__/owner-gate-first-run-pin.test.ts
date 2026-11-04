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

  it('the set of reasons used equals FIRST_RUN_PATHS (no unused entry, no reason off the list)', () => {
    const used = new Set(Object.values(firstRunCalls()).flat())
    expect([...used].sort()).toEqual([...FIRST_RUN_PATHS].sort())
  })

  it('the first pairing keeps its "no approved sender yet" condition at the call site', () => {
    const agents = readFileSync(join(SRC, 'web', 'routes', 'agents.ts'), 'utf-8')
    expect(agents).toContain('const firstPairing = channelHasNoApprovedSender(chDir)')
    expect(agents).toContain("firstPairing ? mayActAsOwnerOrFirstRun(ctx.auth, req, 'first-pairing') : mayActAsOwner(ctx.auth, req)")
  })

  it('the plan login keeps its paired-Bridge-key alternative', () => {
    const src = readFileSync(join(SRC, 'web', 'routes', 'claude-plans-login.ts'), 'utf-8')
    expect(src).toContain("!mayActAsOwnerOrFirstRun(ctx.auth, req, 'claude-plans-login') && !isPairedBridgeKey(ctx.auth)")
  })

  it('mayIssueCredentials and mayActAsOwnerStrict are not exported, and nothing in src calls them', () => {
    expect('mayIssueCredentials' in authModule).toBe(false)
    expect('mayActAsOwnerStrict' in authModule).toBe(false)
    const callers = sourceFiles(SRC).filter((f) => /\b(?:mayIssueCredentials|mayActAsOwnerStrict)\(/.test(readFileSync(f, 'utf-8')))
    expect(callers.map((f) => relative(SRC, f))).toEqual([])
  })
})
