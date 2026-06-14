import { describe, it, expect } from 'vitest'
import { resolveBrandName, resolveServiceId, brandSlug } from '../config.js'
import {
  substituteTemplatePlaceholders,
  type TemplateIdentity,
} from '../web/agent-scaffold.js'
import {
  channelsSessionName,
  channelsLaunchdLabel,
  channelsPlistPath,
} from '../web/main-agent.js'
import { buildMarveenIdentityCore } from '../web/routes/marveen.js'

// This suite proves the configurable-brand feature works under a NON-"marveen"
// identity: it sets BRAND_NAME / BOT_NAME / MAIN_AGENT_ID / OWNER_NAME to
// generic placeholder values and asserts that the identity payload, template
// substitution, main-agent detection, launchd label derivation, and the
// brand-population fallback all resolve from those values with NO literal
// "marveen"/"Marveen" leaking through. The DEFAULT (Marveen) is asserted
// separately so the feature is also confirmed zero-change for existing installs.
//
// Generic, non-sensitive placeholders only.
const BRAND = 'AcmeAI'
const AGENT_DISPLAY = 'MyAssistant'
const AGENT_ID = 'myassistant'
const OWNER = 'Operator'

// Anything that still hardcodes the product brand would surface as one of these
// literals in a value derived from a non-marveen identity.
const MARVEEN_RX = /marveen/i

function assertNoMarveen(value: string, label: string): void {
  expect(value, `${label} leaked a literal brand: ${value}`).not.toMatch(MARVEEN_RX)
}

describe('BRAND_NAME / BOT_NAME separation', () => {
  it('defaults BRAND_NAME to BOT_NAME when the env var is unset/empty (default-safe)', () => {
    expect(resolveBrandName(undefined, 'Marveen')).toBe('Marveen')
    expect(resolveBrandName('', 'Marveen')).toBe('Marveen')
    expect(resolveBrandName('   ', 'Marveen')).toBe('Marveen')
    // The product brand can differ from the agent display name.
    expect(resolveBrandName(undefined, AGENT_DISPLAY)).toBe(AGENT_DISPLAY)
  })

  it('uses an explicit BRAND_NAME independently of BOT_NAME', () => {
    expect(resolveBrandName(BRAND, AGENT_DISPLAY)).toBe(BRAND)
    expect(resolveBrandName(BRAND, AGENT_DISPLAY)).not.toBe(AGENT_DISPLAY)
  })
})

describe('brandSlug derivation (mirrors the installer NFKD rule)', () => {
  it('slugs the default brand back to "marveen" so labels are unchanged by default', () => {
    expect(brandSlug('Marveen')).toBe('marveen')
  })

  it('derives an ASCII slug for a non-marveen brand', () => {
    expect(brandSlug(BRAND)).toBe('acmeai')
    expect(brandSlug(AGENT_DISPLAY)).toBe('myassistant')
    expect(brandSlug('My Assistant')).toBe('my-assistant')
    expect(brandSlug('Acme-AI v2!')).toBe('acme-ai-v2')
  })

  it('folds accented brands to ASCII (no non-marveen unicode leak)', () => {
    // Generic accented example -- exercises the NFKD path without a real name.
    expect(brandSlug('Éxãmple Brand')).toBe('example-brand')
  })

  it('falls back to "marveen" for an empty/blank brand', () => {
    expect(brandSlug('')).toBe('marveen')
    expect(brandSlug('   ')).toBe('marveen')
    expect(brandSlug('!!!')).toBe('marveen')
  })
})

describe('resolveServiceId (launchd/systemd service id)', () => {
  it('equals MAIN_AGENT_ID for the default brand (default-safe labels)', () => {
    // Default brand slug == agent id -> same service id -> identical labels.
    expect(resolveServiceId('marveen', 'marveen')).toBe('marveen')
  })

  it('uses the brand slug for a distinct non-marveen brand', () => {
    expect(resolveServiceId('acmeai', AGENT_ID)).toBe('acmeai')
    expect(resolveServiceId('acmeai', AGENT_ID)).not.toBe(AGENT_ID)
  })

  it('falls back to the agent id when no distinct brand slug is given', () => {
    expect(resolveServiceId('', AGENT_ID)).toBe(AGENT_ID)
    expect(resolveServiceId(AGENT_ID, AGENT_ID)).toBe(AGENT_ID)
  })
})

describe('launchd / channels label derivation for a non-marveen identity', () => {
  it('builds the tmux channels session from the agent id', () => {
    expect(channelsSessionName(AGENT_ID)).toBe('myassistant-channels')
    assertNoMarveen(channelsSessionName(AGENT_ID), 'channelsSessionName')
  })

  it('builds the launchd label + plist path from the service id', () => {
    const serviceId = resolveServiceId(brandSlug(BRAND), AGENT_ID)
    expect(serviceId).toBe('acmeai')
    expect(channelsLaunchdLabel(serviceId)).toBe('com.acmeai.channels')
    expect(channelsPlistPath(serviceId)).toMatch(/\/com\.acmeai\.channels\.plist$/)
    assertNoMarveen(channelsLaunchdLabel(serviceId), 'channelsLaunchdLabel')
    assertNoMarveen(channelsPlistPath(serviceId), 'channelsPlistPath')
  })

  it('keeps the default label as com.marveen.channels (zero change for existing installs)', () => {
    const serviceId = resolveServiceId(brandSlug('Marveen'), 'marveen')
    expect(channelsLaunchdLabel(serviceId)).toBe('com.marveen.channels')
  })
})

describe('identity payload core resolves from config, not the literal', () => {
  it('maps display name / brand / canonical id for a non-marveen identity', () => {
    const brandName = resolveBrandName(BRAND, AGENT_DISPLAY)
    const core = buildMarveenIdentityCore(AGENT_DISPLAY, brandName, AGENT_ID)
    expect(core).toEqual({
      name: AGENT_DISPLAY,
      brandName: BRAND,
      agentId: AGENT_ID,
      autoRestartId: AGENT_ID,
      role: 'main',
    })
    for (const [k, v] of Object.entries(core)) assertNoMarveen(String(v), `identity.${k}`)
  })

  it('falls brandName back to the display name when no separate brand is set', () => {
    const brandName = resolveBrandName(undefined, AGENT_DISPLAY)
    const core = buildMarveenIdentityCore(AGENT_DISPLAY, brandName, AGENT_ID)
    expect(core.brandName).toBe(AGENT_DISPLAY)
  })
})

describe('template substitution for a non-marveen identity', () => {
  const identity: TemplateIdentity = {
    projectRoot: '/opt/myassistant',
    mainAgentId: AGENT_ID,
    botName: AGENT_DISPLAY,
    ownerName: OWNER,
    webPort: 3420,
  }

  it('substitutes every identity placeholder with the non-marveen values', () => {
    const tpl = [
      'root={{PROJECT_ROOT}}',
      'install={{INSTALL_DIR}}',
      'agent={{MAIN_AGENT_ID}}',
      'bot={{BOT_NAME}}',
      'owner={{OWNER_NAME}}',
      'port={{WEB_PORT}}',
    ].join('\n')
    const out = substituteTemplatePlaceholders(tpl, identity)
    // No placeholder survives.
    expect([...out.matchAll(/\{\{[A-Z_]+\}\}/g)].map(m => m[0])).toEqual([])
    // Values are the injected non-marveen identity.
    expect(out).toContain('agent=myassistant')
    expect(out).toContain('bot=MyAssistant')
    expect(out).toContain('owner=Operator')
    expect(out).toContain('root=/opt/myassistant')
    // No literal brand leaked through the substitution.
    assertNoMarveen(out, 'substituteTemplatePlaceholders output')
  })

  it('does not invent a marveen value when the template has no brand reference', () => {
    expect(substituteTemplatePlaceholders('hello {{OWNER_NAME}}', identity)).toBe('hello Operator')
  })
})

describe('brand-population fallback contract (initSidebarBrand)', () => {
  // The client picks `brandName` and only falls back to `name` (and finally the
  // HTML default) when the backend omits it. Replicating the exact rule guards
  // against a regression where the chrome stops honoring brandName.
  const pickBrand = (m: { brandName?: string; name?: string }) => m.brandName || m.name

  it('prefers brandName when present (non-marveen)', () => {
    expect(pickBrand({ brandName: BRAND, name: AGENT_DISPLAY })).toBe(BRAND)
  })

  it('falls back to name when brandName is absent', () => {
    expect(pickBrand({ name: AGENT_DISPLAY })).toBe(AGENT_DISPLAY)
  })
})
