import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook, no type declarations
import { gateDecision, writesToStore } from '../../scripts/hooks/bash-safety-gate.mjs'

const bash = (command: string) => gateDecision('Bash', { command })
const STORE = '/Users/macmini/marveen/store'
const GRANT = `${STORE}/ads-write-grant.json`

// The rule exists because the ads-write grant lives under store/. If an agent can
// rewrite the file that decides whether it may spend money, the gate is decorative.
describe('store/ write guard: the grant file cannot be forged from a shell', () => {
  it('blocks the four ways that were measured as ALLOWED before this rule', () => {
    expect(bash(`echo x > ${GRANT}`).deny).toBe(true)
    expect(bash(`echo x | tee ${GRANT}`).deny).toBe(true)
    expect(bash(`sed -i '' s/1784757600/9999999999/ ${GRANT}`).deny).toBe(true)
    expect(bash(`cp /tmp/forged.json ${GRANT}`).deny).toBe(true)
  })
  it('blocks append as well as overwrite', () => {
    expect(bash(`echo x >> ${GRANT}`).deny).toBe(true)
  })
  it('blocks the relative-path route out of an agent directory', () => {
    expect(bash('echo x > ../../store/ads-write-grant.json').deny).toBe(true)
    expect(bash('cp /tmp/f.json ../../store/ads-write-grant.json').deny).toBe(true)
  })
  it('blocks a write hidden after an innocent first segment', () => {
    expect(bash(`cd /tmp && echo x > ${GRANT}`).deny).toBe(true)
    expect(bash(`ls -la; echo x > ${GRANT}`).deny).toBe(true)
  })
  it('blocks moving, linking and re-permissioning', () => {
    expect(bash(`mv /tmp/f.json ${GRANT}`).deny).toBe(true)
    expect(bash(`ln -sf /tmp/f.json ${GRANT}`).deny).toBe(true)
    expect(bash(`truncate -s 0 ${GRANT}`).deny).toBe(true)
    expect(bash(`dd if=/tmp/f.json of=${GRANT}`).deny).toBe(true)
  })
  it('blocks copying a secret OUT of store/ -- a leak is a leak in either direction', () => {
    expect(bash(`cp ${STORE}/.dashboard-token /tmp/`).deny).toBe(true)
    expect(bash(`rsync ${STORE}/vault.json /tmp/`).deny).toBe(true)
  })
  it('names the legitimate route in the refusal, so nobody hunts for a workaround', () => {
    const r = bash(`echo x > ${GRANT}`)
    expect(r.reason).toMatch(/Nova/)
    expect(r.reason).toMatch(/OLVASNI szabad/)
  })
})

describe('store/ write guard: reading stays untouched', () => {
  it('still allows reading the dashboard token (agents do this by design)', () => {
    expect(bash(`cat ${STORE}/.dashboard-token`).deny).toBe(false)
    expect(bash(`TOKEN=$(cat ${STORE}/.dashboard-token)`).deny).toBe(false)
  })
  it('still allows reading the audit log', () => {
    expect(bash(`tail -20 ${STORE}/logs/ads-write-grant.jsonl`).deny).toBe(false)
    expect(bash(`grep DENIED ${STORE}/logs/ads-write-grant.jsonl`).deny).toBe(false)
  })
  it('allows reading FROM store/ while writing somewhere else', () => {
    // The narrow redirect rule exists exactly so this stays possible.
    expect(bash(`cat ${STORE}/logs/x.log > /tmp/out.txt`).deny).toBe(false)
    expect(writesToStore(`cat ${STORE}/logs/x.log > /tmp/out.txt`)).toBe(false)
  })
  it('does not touch writes outside store/', () => {
    expect(bash('echo x > /tmp/scratch.json').deny).toBe(false)
    expect(bash('cp /tmp/a /tmp/b').deny).toBe(false)
    expect(bash('echo x > /Users/macmini/marveen/agents/bit/notes.md').deny).toBe(false)
  })
  it('does not catch an unrelated directory that merely contains "store"', () => {
    expect(bash('echo x > /Users/macmini/marveen/agents/bit/mystore/f.json').deny).toBe(false)
    expect(bash('echo x > /tmp/store-backup/f.json').deny).toBe(false)
  })
})

describe('store/ write guard: existing rules still behave', () => {
  it('ssh key reads stay denied', () => {
    expect(bash('cat ~/.ssh/id_rsa').deny).toBe(true)
  })
  it('ordinary commands stay allowed', () => {
    expect(bash('git status').deny).toBe(false)
    expect(bash('npx vitest run').deny).toBe(false)
  })
  it('non-Bash tools are out of scope', () => {
    expect(gateDecision('Read', { command: `echo x > ${GRANT}` }).deny).toBe(false)
  })
})
