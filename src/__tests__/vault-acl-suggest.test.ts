// VAULTSZELES826 PR-A: scripts/vault-acl-suggest.mjs proposes store/vault-acl.json from the observation week.
// Only an authenticated row (a sub-agent's OWN token, kind 'agent') becomes a proposal; a self-asserted X-Agent-Id
// claim is listed apart and never proposed; SSH material and the vault's sub-resources never are.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- a plain .mjs script, no type declarations
import { parseRecords, suggest, agentReadableId } from '../../scripts/vault-acl-suggest.mjs'

const E = '\u001b'
// One pino-pretty record, coloured like dashboard.log.
function pretty(date: string, msg: string, fields: Record<string, unknown>): string {
  const head = `[${date} 08:11:08.428 +0100] ${E}[32mINFO${E}[39m (66114): ${E}[36m${msg}${E}[39m`
  return [head, ...Object.entries(fields).map(([k, v]) => `    ${E}[35m${k}${E}[39m: ${JSON.stringify(v)}`)].join('\n')
}
const read = (date: string, f: Record<string, unknown>) => pretty(date, 'vault: secret value read', { event: 'vault-read', mode: 'audit', agent_mode: 'audit', channel: 'value', refused: false, found: true, ...f })
const scope = (date: string, agent: string, method: string, path: string) =>
  pretty(date, 'agent token: request outside the sub-agent scope refused (403)', { agent, rule: 'agent-token-scope', method, path })

const LOG = [
  read('2026-11-11', { id: 'NETLIFY_AUTH_TOKEN', kind: 'agent', principal: 'mira', acl: 'no-acl', claimed: null }),
  read('2026-11-11', { id: 'NETLIFY_AUTH_TOKEN', kind: 'agent', principal: 'mira', acl: 'no-acl', claimed: null }),
  pretty('2026-11-11', 'command task ran', { task: 'x' }),
  read('2026-11-12', { id: 'GROMZO_M2_LINKCODE', kind: 'agent', principal: 'abel', acl: 'no-acl', claimed: null }),
  read('2026-11-12', { id: 'ALREADY', kind: 'agent', principal: 'geri', acl: 'allowed', claimed: null }),
  read('2026-11-12', { id: 'ssh-key-abc', kind: 'agent', principal: 'abel', acl: 'no-acl', claimed: null, refused: true }),
  read('2026-11-12', { id: 'GONE', kind: 'agent', principal: 'abel', acl: 'no-acl', claimed: null, found: false }),
  read('2026-11-12', { id: 'SHARED_READ', kind: 'token', principal: 'token', acl: 'no-acl', claimed: 'boni' }),
  read('2026-11-12', { id: 'OWNER_READ', kind: 'token', principal: 'token', acl: 'owner-lane', claimed: null }),
  scope('2026-11-12', 'abel', 'GET', '/api/updates/status'),
  scope('2026-11-12', 'abel', 'GET', '/api/updates/status'),
  read('2026-11-01', { id: 'OLD', kind: 'agent', principal: 'abel', acl: 'no-acl', claimed: null }),
  JSON.stringify({ level: 30, time: Date.parse('2026-11-12T10:00:00Z'), msg: 'vault: secret value read', id: 'JSONLINE', kind: 'agent', principal: 'orsi', found: true }),
].join('\n')

describe('vault-acl-suggest', () => {
  it('S1 parses coloured pino-pretty records and JSON lines, and only the two kinds it reads', () => {
    const recs = parseRecords(LOG)
    expect(recs).toHaveLength(12)
    expect(recs[0]).toMatchObject({ date: '2026-11-11', msg: 'vault: secret value read', id: 'NETLIFY_AUTH_TOKEN', kind: 'agent', principal: 'mira', found: true })
    expect(recs.at(-1)).toMatchObject({ date: '2026-11-12', id: 'JSONLINE', principal: 'orsi' })
  })

  it('S2 proposes only own-token reads, merged into the current file, with counts', () => {
    const r = suggest(parseRecords(LOG), { ALREADY: ['geri'], KEEP: ['samu'] }, '2026-11-10')
    expect(r.proposed_acl).toEqual({
      ALREADY: ['geri'], GROMZO_M2_LINKCODE: ['abel'], JSONLINE: ['orsi'], KEEP: ['samu'], NETLIFY_AUTH_TOKEN: ['mira'],
    })
    expect(r.new_entries).toEqual([
      { id: 'GROMZO_M2_LINKCODE', agent: 'abel', reads: 1 },
      { id: 'JSONLINE', agent: 'orsi', reads: 1 },
      { id: 'NETLIFY_AUTH_TOKEN', agent: 'mira', reads: 2 },
    ])
  })

  it('S3 never proposes SSH material, a missing id, a claimed (shared-token) read or an owner read', () => {
    const r = suggest(parseRecords(LOG), {}, '2026-11-10')
    const ids = Object.keys(r.proposed_acl)
    for (const id of ['ssh-key-abc', 'GONE', 'SHARED_READ', 'OWNER_READ']) expect(ids).not.toContain(id)
    expect(r.floor_refused).toBe(1)
    expect(r.not_found).toEqual([{ agent: 'abel', id: 'GONE', count: 1 }])
    expect(r.claimed_unverified).toEqual([{ claimed: 'boni', id: 'SHARED_READ', count: 1 }])
  })

  it('S4 lists the week\'s scope refusals, and --since drops older rows', () => {
    const r = suggest(parseRecords(LOG), {}, '2026-11-10')
    expect(r.scope_403).toEqual([{ agent: 'abel', method: 'GET', path: '/api/updates/status', count: 2 }])
    expect(Object.keys(r.proposed_acl)).not.toContain('OLD')
    expect(Object.keys(suggest(parseRecords(LOG), {}, '').proposed_acl)).toContain('OLD')
    expect(r.window).toEqual({ from: '2026-11-11', to: '2026-11-12', since: '2026-11-10' })
  })

  it('S5 the floor is the server\'s (vault-acl.ts isAgentReadableDecodedVaultId)', async () => {
    const { isAgentReadableDecodedVaultId } = await import('../web/vault-acl.js')
    for (const id of ['EXISTS', 'ssh-key-x', 'SSH-servers', 'bindings', 'Resolve', 'a/b', '', ' ', 'sshx', 'my-ssh']) {
      expect(agentReadableId(id), id).toBe(isAgentReadableDecodedVaultId(id))
    }
  })
})
