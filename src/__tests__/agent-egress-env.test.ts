// AGENTEGRESS1111: launcher paths must select only the agent's own regular vendor list.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { agentVendorHostsEnv } from '../web/agent-egress-env.js'

let store: string
beforeEach(() => { store = mkdtempSync(join(tmpdir(), 'agent-egress-')) })
afterEach(() => { rmSync(store, { recursive: true, force: true }) })
const quote = (s: string) => `'${s}'`
const UNSET = 'unset BASH_EGRESS_AGENT_VENDOR_HOSTS && '

describe('agentVendorHostsEnv', () => {
  it('exports the quoted absolute path of a regular file', () => {
    const file = join(store, 'egress-vendor-hosts-alpha.json')
    writeFileSync(file, '{}')
    expect(agentVendorHostsEnv('alpha', quote, store)).toBe(`export BASH_EGRESS_AGENT_VENDOR_HOSTS='${file}' && `)
  })
  it('unsets a missing file', () => {
    expect(agentVendorHostsEnv('alpha', quote, store)).toBe(UNSET)
  })
  it('unsets a symlink to a regular file', () => {
    const target = join(store, 'target.json')
    writeFileSync(target, '{}')
    symlinkSync(target, join(store, 'egress-vendor-hosts-alpha.json'))
    expect(agentVendorHostsEnv('alpha', quote, store)).toBe(UNSET)
  })
  it('unsets a directory with the list name', () => {
    mkdirSync(join(store, 'egress-vendor-hosts-alpha.json'))
    expect(agentVendorHostsEnv('alpha', quote, store)).toBe(UNSET)
  })
  it.each(['../x', 'a/b', '.hidden', ''])('unsets invalid agent name %j', (name) => {
    const file = join(store, 'egress-vendor-hosts-' + name + '.json')
    expect(resolve(file).startsWith(store + sep)).toBe(true)
    // AGENTEGRESS1111: '../x' nests under the literal directory 'egress-vendor-hosts-..'.
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{}')
    expect(agentVendorHostsEnv(name, quote, store)).toBe(UNSET)
  })
})
