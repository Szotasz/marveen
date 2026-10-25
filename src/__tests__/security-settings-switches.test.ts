import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The dashboard's Security tab (module 'security'): seven switches, every default the shipped gate
// behaviour. This suite pins the registry entries (default, values, which changes loosen), the
// scaffold wiring that reads them, and the hook-side reader through the real hook processes with
// SECURITY_SETTINGS_ROOT pointing at a throwaway install root.

const switches = new Map<string, string>()
vi.mock('../settings-store.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../settings-store.js')>()
  return {
    ...orig,
    getEffectiveSettingValue: (key: string) => (switches.has(key) ? switches.get(key)! : orig.getEffectiveSettingValue(key)),
  }
})

const { getSettingDefinition, validateSettingValue } = await import('../config-registry.js')
const {
  writeAgentSettingsFromProfile, agentSettingsPath, LEGACY_BASH_EGRESS_DENY, BASH_EGRESS_DENY,
  bashExternalOpen, credentialGateFleetMode, destructiveGateForAll, agentGetsCredentialGate, agentGetsDestructiveGate,
} = await import('../web/agent-scaffold.js')
const { agentDir } = await import('../web/agent-config.js')
const { loadProfileTemplate } = await import('../web/profiles.js')
const { PROJECT_ROOT, MAIN_AGENT_ID } = await import('../config.js')

const KEYS = [
  'SECURITY_BASH_EXTERNAL', 'SECURITY_QUARANTINE_POSTURE', 'MAIL_OWNER_CC', 'SECURITY_COPY_GATE_MODE',
  'SECURITY_RECIPIENT_LEDGER_MODE', 'SECURITY_CREDENTIAL_GATE', 'SECURITY_DESTRUCTIVE_GATE',
]

describe('registry entries', () => {
  it('all seven live on the Security tab and declare which change loosens them', () => {
    for (const key of KEYS) {
      const def = getSettingDefinition(key)
      expect(def, key).toBeDefined()
      expect(def!.module, key).toBe('security')
      expect(typeof def!.loosens, key).toBe('function')
    }
  })

  it('every default is the shipped gate behaviour', () => {
    expect(getSettingDefinition('SECURITY_BASH_EXTERNAL')!.default).toBe('0')
    expect(getSettingDefinition('SECURITY_QUARANTINE_POSTURE')!.default).toBe('allowlist')
    expect(getSettingDefinition('MAIL_OWNER_CC')!.default).toBe('')
    expect(getSettingDefinition('SECURITY_COPY_GATE_MODE')!.default).toBe('block')
    expect(getSettingDefinition('SECURITY_RECIPIENT_LEDGER_MODE')!.default).toBe('block')
    expect(getSettingDefinition('SECURITY_CREDENTIAL_GATE')!.default).toBe('off')
    expect(getSettingDefinition('SECURITY_DESTRUCTIVE_GATE')!.default).toBe('0')
  })

  it('loosening and tightening are told apart', () => {
    const loosens = (key: string, from: string, to: string) => getSettingDefinition(key)!.loosens!(from, to)
    expect(loosens('SECURITY_BASH_EXTERNAL', '0', '1')).toBe(true)
    expect(loosens('SECURITY_BASH_EXTERNAL', '1', '0')).toBe(false)
    expect(loosens('SECURITY_QUARANTINE_POSTURE', 'allowlist', 'denylist')).toBe(true)
    expect(loosens('SECURITY_QUARANTINE_POSTURE', 'denylist', 'allowlist')).toBe(false)
    expect(loosens('MAIL_OWNER_CC', 'owner@example.org', '')).toBe(true)
    expect(loosens('MAIL_OWNER_CC', 'owner@example.org', 'other@example.org')).toBe(true)
    expect(loosens('MAIL_OWNER_CC', 'owner@example.org', 'OWNER@example.org')).toBe(false)
    expect(loosens('MAIL_OWNER_CC', '', 'owner@example.org')).toBe(false)
    for (const key of ['SECURITY_COPY_GATE_MODE', 'SECURITY_RECIPIENT_LEDGER_MODE']) {
      expect(loosens(key, 'block', 'warn')).toBe(true)
      expect(loosens(key, 'warn', 'block')).toBe(false)
    }
    expect(loosens('SECURITY_CREDENTIAL_GATE', 'block', 'warn')).toBe(true)
    expect(loosens('SECURITY_CREDENTIAL_GATE', 'warn', 'off')).toBe(true)
    expect(loosens('SECURITY_CREDENTIAL_GATE', 'off', 'block')).toBe(false)
    expect(loosens('SECURITY_DESTRUCTIVE_GATE', '1', '0')).toBe(true)
    expect(loosens('SECURITY_DESTRUCTIVE_GATE', '0', '1')).toBe(false)
  })

  it('MAIL_OWNER_CC takes one address or nothing', () => {
    const def = getSettingDefinition('MAIL_OWNER_CC')!
    expect(validateSettingValue(def, '').ok).toBe(true)
    expect(validateSettingValue(def, 'owner@example.org').ok).toBe(true)
    expect(validateSettingValue(def, 'a@example.org, b@example.org').ok).toBe(false)
    expect(validateSettingValue(def, 'not-an-address').ok).toBe(false)
  })

  it('the enum switches refuse a value outside their set', () => {
    expect(validateSettingValue(getSettingDefinition('SECURITY_COPY_GATE_MODE')!, 'off').ok).toBe(false)
    expect(validateSettingValue(getSettingDefinition('SECURITY_CREDENTIAL_GATE')!, 'warn').ok).toBe(true)
  })
})

describe('scaffold wiring', () => {
  const NAME = 'security-switch-test-agent'
  const DIR = agentDir(NAME)
  const deny = (): string[] => JSON.parse(readFileSync(agentSettingsPath(NAME), 'utf-8')).permissions.deny
  const hooksText = (): string => JSON.stringify(JSON.parse(readFileSync(agentSettingsPath(NAME), 'utf-8')).hooks ?? {})

  beforeEach(() => {
    switches.clear()
    // A pre-existing dir means we are not in a clean checkout: refuse rather than delete it.
    if (existsSync(DIR)) throw new Error(`refusing: ${DIR} already exists`)
    mkdirSync(DIR, { recursive: true })
    writeFileSync(join(DIR, 'agent-config.json'), JSON.stringify({}, null, 2))
  })
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }) })

  it('every switch reads as off when nothing is set', () => {
    expect(bashExternalOpen()).toBe(false)
    expect(credentialGateFleetMode()).toBe('off')
    expect(destructiveGateForAll()).toBe(false)
  })

  it('SECURITY_BASH_EXTERNAL drops the curl / wget rules and keeps nc / ncat / telnet', () => {
    const profile = loadProfileTemplate('default')
    writeAgentSettingsFromProfile(NAME, profile)
    for (const rule of LEGACY_BASH_EGRESS_DENY) expect(deny()).toContain(rule)
    switches.set('SECURITY_BASH_EXTERNAL', '1')
    writeAgentSettingsFromProfile(NAME, profile)
    for (const rule of LEGACY_BASH_EGRESS_DENY) expect(deny()).not.toContain(rule)
    for (const rule of BASH_EGRESS_DENY) expect(deny()).toContain(rule)
  })

  it('SECURITY_CREDENTIAL_GATE warn/block wires the gate for every sub-agent, never the main agent', () => {
    const profile = loadProfileTemplate('default')
    expect(agentGetsCredentialGate(NAME, profile)).toBe(false)
    for (const mode of ['warn', 'block']) {
      switches.set('SECURITY_CREDENTIAL_GATE', mode)
      expect(credentialGateFleetMode()).toBe(mode)
      expect(agentGetsCredentialGate(NAME, profile)).toBe(true)
      expect(agentGetsCredentialGate(MAIN_AGENT_ID, profile)).toBe(false)
    }
    writeAgentSettingsFromProfile(NAME, profile)
    expect(hooksText()).toContain('credential-gate.py')
  })

  it('SECURITY_DESTRUCTIVE_GATE wires the gate for every sub-agent, never the main agent', () => {
    const profile = loadProfileTemplate('default')
    expect(agentGetsDestructiveGate(NAME, profile)).toBe(false)
    switches.set('SECURITY_DESTRUCTIVE_GATE', '1')
    expect(agentGetsDestructiveGate(NAME, profile)).toBe(true)
    expect(agentGetsDestructiveGate(MAIN_AGENT_ID, profile)).toBe(false)
    writeAgentSettingsFromProfile(NAME, profile)
    expect(hooksText()).toContain('destructive-gate.py')
  })
})

describe('the hooks read the switches (real processes, a throwaway install root)', () => {
  let root: string
  const setOverrides = (o: Record<string, string>) => writeFileSync(join(root, 'store', 'config-overrides.json'), JSON.stringify(o))
  const run = (script: string, payload: unknown, extraEnv: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(PROJECT_ROOT, ...script.split('/'))], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env, SECURITY_SETTINGS_ROOT: root, ...extraEnv },
    })
  const denied = (r: ReturnType<typeof run>) => r.status === 2 || /"permissionDecision":"deny"/.test(r.stdout)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'security-switches-'))
    mkdirSync(join(root, 'store'))
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('bash-egress-parser: external curl denied by default, allowed with SECURITY_BASH_EXTERNAL on', () => {
    const payload = { tool_name: 'Bash', tool_input: { command: 'curl -s http://example.com/x' } }
    expect(denied(run('scripts/hooks/bash-egress-parser.mjs', payload))).toBe(true)
    setOverrides({ SECURITY_BASH_EXTERNAL: '1' })
    expect(denied(run('scripts/hooks/bash-egress-parser.mjs', payload))).toBe(false)
    setOverrides({ SECURITY_BASH_EXTERNAL: 'yes' })
    expect(denied(run('scripts/hooks/bash-egress-parser.mjs', payload))).toBe(true)
  })

  it('bash-egress-parser: the .env line counts, the override wins over it', () => {
    const payload = { tool_name: 'Bash', tool_input: { command: 'curl -s http://example.com/x' } }
    writeFileSync(join(root, '.env'), 'SECURITY_BASH_EXTERNAL="1"\n')
    expect(denied(run('scripts/hooks/bash-egress-parser.mjs', payload))).toBe(false)
    setOverrides({ SECURITY_BASH_EXTERNAL: '0' })
    expect(denied(run('scripts/hooks/bash-egress-parser.mjs', payload))).toBe(true)
  })

  it('a malformed overrides file reads as the shipped default', () => {
    writeFileSync(join(root, 'store', 'config-overrides.json'), '{ not json')
    const payload = { tool_name: 'Bash', tool_input: { command: 'curl -s http://example.com/x' } }
    expect(denied(run('scripts/hooks/bash-egress-parser.mjs', payload))).toBe(true)
  })

  it('email-send-gate: an unsourced draft address is denied, and passes with a notice in warn mode', () => {
    const draft = { tool_name: 'mcp__google-workspace__manage_email', tool_input: { operation: 'send', draft: true, to: 'nobody-sourced@example.invalid' } }
    expect(denied(run('scripts/email-send-gate.mjs', draft))).toBe(true)
    setOverrides({ SECURITY_RECIPIENT_LEDGER_MODE: 'warn' })
    const r = run('scripts/email-send-gate.mjs', draft)
    expect(denied(r)).toBe(false)
    expect(JSON.parse(r.stdout).systemMessage).toContain('nobody-sourced@example.invalid')
  })

  it('email-send-gate warn mode never lifts a deny that has another reason', () => {
    setOverrides({ SECURITY_RECIPIENT_LEDGER_MODE: 'warn' })
    // no draft flag: the draft rule denies whatever the ledger says
    const send = { tool_name: 'mcp__google-workspace__manage_email', tool_input: { operation: 'send', to: 'nobody-sourced@example.invalid' } }
    expect(denied(run('scripts/email-send-gate.mjs', send))).toBe(true)
    const direct = { tool_name: 'mcp__gmail__send_email', tool_input: { to: 'nobody-sourced@example.invalid', subject: 's', body: 'b' } }
    expect(denied(run('scripts/email-send-gate.mjs', direct))).toBe(true)
  })
})

describe('egress-gate: the quarantine-reader posture', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'security-posture-'))
    mkdirSync(join(root, 'store'))
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('the file decides until the switch is set; a set switch wins either way', async () => {
    process.env.SECURITY_SETTINGS_ROOT = root
    try {
      // @ts-expect-error -- plain .mjs hook script, no types
      const { effectiveQuarantinePosture } = await import('../../scripts/hooks/egress-gate.mjs')
      expect(effectiveQuarantinePosture('denylist')).toBe('denylist')
      expect(effectiveQuarantinePosture('allowlist')).toBe('allowlist')
      writeFileSync(join(root, 'store', 'config-overrides.json'), JSON.stringify({ SECURITY_QUARANTINE_POSTURE: 'allowlist' }))
      expect(effectiveQuarantinePosture('denylist')).toBe('allowlist')
      writeFileSync(join(root, 'store', 'config-overrides.json'), JSON.stringify({ SECURITY_QUARANTINE_POSTURE: 'denylist' }))
      expect(effectiveQuarantinePosture('allowlist')).toBe('denylist')
      writeFileSync(join(root, 'store', 'config-overrides.json'), JSON.stringify({ SECURITY_QUARANTINE_POSTURE: 'open' }))
      expect(effectiveQuarantinePosture('allowlist')).toBe('allowlist')
    } finally {
      delete process.env.SECURITY_SETTINGS_ROOT
    }
  })
})
