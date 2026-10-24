import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// #1705 maintainer decision (2026-10-14): the yt-dlp deny rules -- and the
// researcher allow lines that go with them -- are written ONLY when the
// install-wide YT_DLP_INGEST_ONLY switch is on. This suite drives the real
// scaffold output through both switch states; the rule-set level (deny corpus,
// merge) lives in bash-egress-deny.test.ts.

let switchValue: string | number = '0'
vi.mock('../settings-store.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../settings-store.js')>()
  return {
    ...orig,
    getEffectiveSettingValue: (key: string) => (key === 'YT_DLP_INGEST_ONLY' ? switchValue : orig.getEffectiveSettingValue(key)),
  }
})

const {
  writeAgentSettingsFromProfile, agentSettingsPath, ensureBashEgressDeny, seedSettingsFromTemplate,
  resolveTemplatePlaceholders, YT_DLP_EGRESS_DENY, YT_INGEST_ALLOW, BASH_EGRESS_DENY, LEGACY_BASH_EGRESS_DENY,
} = await import('../web/agent-scaffold.js')
const { agentDir } = await import('../web/agent-config.js')
const { listProfileTemplates, loadProfileTemplate, profileWantsYtIngest } = await import('../web/profiles.js')
const { getSettingDefinition } = await import('../config-registry.js')
const { PROJECT_ROOT, MAIN_AGENT_ID } = await import('../config.js')

const NAME = 'ingest-switch-test-agent'
const DIR = agentDir(NAME)
const YT = /yt[-_]dlp|yt-ingest|yt-read/

function written(): { raw: string; allow: string[]; deny: string[] } {
  const raw = readFileSync(agentSettingsPath(NAME), 'utf-8')
  const perms = JSON.parse(raw).permissions as { allow: string[]; deny: string[] }
  return { raw, allow: perms.allow, deny: perms.deny }
}
const resolvedAllow = YT_INGEST_ALLOW.map((r) => r.replace('${PROJECT_ROOT}', PROJECT_ROOT))
const templateText = () => resolveTemplatePlaceholders(readFileSync(join(PROJECT_ROOT, 'templates', 'settings.json.template'), 'utf-8'))

beforeEach(() => {
  switchValue = '0'
  // A pre-existing dir means we are not in a clean checkout: refuse rather than
  // delete something we did not create.
  if (existsSync(DIR)) throw new Error(`refusing: ${DIR} already exists`)
  mkdirSync(DIR, { recursive: true })
  writeFileSync(join(DIR, 'agent-config.json'), JSON.stringify({}, null, 2))
})
afterEach(() => {
  rmSync(DIR, { recursive: true, force: true })
})

describe('switch OFF (the default)', () => {
  it('the registry default is off', () => {
    expect(getSettingDefinition('YT_DLP_INGEST_ONLY')?.default).toBe('0')
  })

  // Every shipped profile, the researcher included: not one yt-dlp, yt-ingest
  // or yt-read string anywhere in the written settings.
  for (const profile of listProfileTemplates()) {
    it(`profile "${profile.id}": no yt rule and no yt allow line in the scaffold output`, () => {
      writeAgentSettingsFromProfile(NAME, loadProfileTemplate(profile.id))
      const { raw, deny } = written()
      expect(raw).not.toMatch(YT)
      expect(deny).toEqual(expect.arrayContaining(BASH_EGRESS_DENY))
    })
  }

  it('the template result is the template text verbatim, with no yt rule', () => {
    const tpl = templateText()
    expect(seedSettingsFromTemplate(tpl, false)).toBe(tpl)
    expect(tpl).not.toMatch(YT)
  })
})

describe('switch ON', () => {
  beforeEach(() => { switchValue = '1' })

  it('the researcher profile is the one that asks for the allow lines', () => {
    expect(profileWantsYtIngest(loadProfileTemplate('researcher'))).toBe(true)
    expect(profileWantsYtIngest(loadProfileTemplate('default'))).toBe(false)
  })

  it('researcher: the yt-dlp deny rules AND the yt-ingest allow lines are written', () => {
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('researcher'))
    const { allow, deny } = written()
    expect(deny).toEqual(expect.arrayContaining([...BASH_EGRESS_DENY, ...YT_DLP_EGRESS_DENY]))
    expect(allow).toEqual(expect.arrayContaining(resolvedAllow))
  })

  it('a profile without ytIngest gets the deny rules but no allow line', () => {
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('default'))
    const { allow, deny } = written()
    expect(deny).toEqual(expect.arrayContaining(YT_DLP_EGRESS_DENY))
    expect(allow.filter((r) => /yt-ingest|yt-read/.test(r))).toEqual([])
  })

  it('survives a respawn without duplicating a rule', () => {
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('researcher'))
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('researcher'))
    const { allow, deny } = written()
    for (const r of YT_DLP_EGRESS_DENY) expect(deny.filter((d) => d === r)).toHaveLength(1)
    for (const r of resolvedAllow) expect(allow.filter((a) => a === r)).toHaveLength(1)
  })

  it('the template result carries the shared rules plus the yt-dlp rules', () => {
    const seeded = JSON.parse(seedSettingsFromTemplate(templateText(), true))
    expect(seeded.permissions.deny).toEqual([...BASH_EGRESS_DENY, ...YT_DLP_EGRESS_DENY])
    // Only the deny list changes; the hooks block is carried over intact.
    expect(seeded.hooks).toEqual(JSON.parse(templateText()).hooks)
  })

  it('the main agent\'s own config dir gets the yt-dlp rules through the startup merge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yt-switch-main-'))
    try {
      expect(ensureBashEgressDeny(MAIN_AGENT_ID, dir)).toBe(true)
      const deny = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8')).permissions.deny as string[]
      // develop (#1931): with BASH_EGRESS_HOST_ALLOW off the legacy curl-https / wget rules ride too
      expect(deny).toEqual([...BASH_EGRESS_DENY, ...YT_DLP_EGRESS_DENY, ...LEGACY_BASH_EGRESS_DENY])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('registry documentation', () => {
  it('names what it blocks, what it allows and what it needs to be useful', () => {
    const def = getSettingDefinition('YT_DLP_INGEST_ONLY')
    expect(def).toMatchObject({ type: 'boolean', module: 'agents', secret: false })
    expect(def!.description).toContain('yt-ingest.sh')
    expect(def!.description).toContain('yt-read.sh')
    expect(def!.description).toContain('binary_egress["yt-dlp"]')
    expect(def!.description).toContain('skill')
  })
})
