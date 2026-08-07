import { describe, it, expect } from 'vitest'
import { classifyPersona, suggestForAgent , humanModelLabel } from '../web/model-suggest.js'
import { DISTRIBUTION_DEFAULT_AGENT_MODEL } from '../config-registry.js'

describe('classifyPersona', () => {
  it('suggests Opus for an architect persona', () => {
    const text = 'Te vagy a fleet IT rendszerarchitektje. Elosztott rendszerek, mikroszolgáltatás-architektúrák, komplex döntések.'
    const result = classifyPersona(text)
    expect(result.suggestedModel).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
  })

  it('suggests Haiku for a fitness coach persona', () => {
    const text = 'A neved Peter. Te vagy a fleet sportedzője. Edzés, fitness, futás, kerékpár, úszás -- rövid válaszok.'
    const result = classifyPersona(text)
    expect(result.suggestedModel).toBe('claude-haiku-4-5-20251001')
  })

  it('suggests Haiku for an accounting persona', () => {
    const text = 'Pénzügyi szakember vagy. Számvitel, könyvelés, könyvelő feladatok, adminisztráció.'
    const result = classifyPersona(text)
    expect(result.suggestedModel).toBe('claude-haiku-4-5-20251001')
  })

  it('suggests Sonnet as default for a general backend dev', () => {
    const text = 'Senior backend fejlesztő vagy. REST API, adatbázis, integrációk, tesztelés.'
    const result = classifyPersona(text)
    expect(result.suggestedModel).toBe('claude-sonnet-5')
  })

  it('overrides to Opus when contextTokens > 150k regardless of persona', () => {
    const text = 'Egyszerű feladatok, rövid válaszok, sport, edzés.'
    const result = classifyPersona(text, 160_000)
    expect(result.suggestedModel).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
    expect(result.reason).toMatch(/kontextus/)
  })

  it('does not suggest Haiku when fewer than 2 keyword hits', () => {
    const text = 'Általános asszisztens. Edzés az egyik feladat.'
    const result = classifyPersona(text)
    // Only 1 haiku keyword hit -- should fall back to Sonnet
    expect(result.suggestedModel).toBe('claude-sonnet-5')
  })
})

describe('suggestForAgent -- base (no signals)', () => {
  it('sets changeAdvised=false when current model matches suggestion', () => {
    const text = 'Senior backend fejlesztő, REST API, adatbázis.'
    const result = suggestForAgent('zack', 'claude-sonnet-5', text)
    expect(result.changeAdvised).toBe(false)
    expect(result.agent).toBe('zack')
  })

  it('sets changeAdvised=true when models differ', () => {
    const text = 'IT architekt. Komplex elosztott rendszerterv, mikroszolgáltatás, stratégiai döntések.'
    const result = suggestForAgent('rick', 'claude-sonnet-5', text)
    expect(result.changeAdvised).toBe(true)
    expect(result.suggestedModel).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
  })

  it('normalises [1m] suffix for comparison', () => {
    const text = 'IT architekt. Komplex elosztott rendszerterv, mikroszolgáltatás, stratégiai döntések.'
    // Plain opus-5 vs the suggested opus-5[1m]: same family after normalize(),
    // so no change is advised -- the suffix alone must not trigger churn.
    const result = suggestForAgent('rick', 'claude-opus-5', text)
    expect(result.changeAdvised).toBe(false)
  })

  it('an agent still on Opus 4.8 IS advised to move to the distribution default (MODELSUGGEST807)', () => {
    const text = 'IT architekt. Komplex elosztott rendszerterv, mikroszolgáltatás, stratégiai döntések.'
    const result = suggestForAgent('rick', 'claude-opus-4-8[1m]', text)
    expect(result.suggestedModel).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
    expect(result.changeAdvised).toBe(true)
  })
})

describe('suggestForAgent -- AgentSignals thresholds', () => {
  const neutralPersona = 'Általános asszisztens vagy.'

  it('tokenAvgInputPerCall > 10K alone adds 1 opus signal point (below threshold without persona hits)', () => {
    // 1 signal hit alone is not enough to push to Opus (need >=2 total)
    const result = suggestForAgent('x', 'claude-sonnet-5', neutralPersona, 0, {
      tokenAvgInputPerCall: 15_000,
    })
    expect(result.suggestedModel).toBe('claude-sonnet-5')
  })

  it('tokenAvgInputPerCall > 10K + mcpServerCount >= 4 pushes to Opus (2 signal hits)', () => {
    const result = suggestForAgent('x', 'claude-sonnet-5', neutralPersona, 0, {
      tokenAvgInputPerCall: 15_000,
      mcpServerCount: 5,
    })
    expect(result.suggestedModel).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
    expect(result.changeAdvised).toBe(true)
  })

  it('mcpServerCount >= 4 + kanbanUrgentCount >= 2 pushes to Opus (2 signal hits)', () => {
    const result = suggestForAgent('x', 'claude-sonnet-5', neutralPersona, 0, {
      mcpServerCount: 4,
      kanbanUrgentCount: 3,
    })
    expect(result.suggestedModel).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
  })

  it('scheduledFreqPerDay >= 10 alone adds 1 haiku signal point (not enough without persona)', () => {
    const result = suggestForAgent('x', 'claude-sonnet-5', neutralPersona, 0, {
      scheduledFreqPerDay: 96,
    })
    expect(result.suggestedModel).toBe('claude-sonnet-5')
  })

  it('scheduledFreqPerDay >= 10 + haiku persona keywords pushes to Haiku', () => {
    const haikuPersona = 'Sport, edzés, futás, kerékpár, tréner.'
    const result = suggestForAgent('peter', 'claude-sonnet-5', haikuPersona, 0, {
      scheduledFreqPerDay: 48,
    })
    expect(result.suggestedModel).toBe('claude-haiku-4-5-20251001')
  })

  it('opus signal hits block Haiku even with >= 2 haiku keyword hits', () => {
    // haiku persona + 1 haiku signal + 2 opus signals -> Opus wins
    const haikuPersona = 'Sport, edzés, fitness, edző -- rövid feladatok.'
    const result = suggestForAgent('x', 'claude-sonnet-5', haikuPersona, 0, {
      scheduledFreqPerDay: 48,   // +1 haiku signal
      mcpServerCount: 5,          // +1 opus signal
      kanbanUrgentCount: 2,       // +1 opus signal
    })
    // totalOpus=2 (signals) > 0, so Haiku condition fails; totalOpus>=2 -> Opus
    expect(result.suggestedModel).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
  })

  it('context override (>150K) wins over all signals', () => {
    const result = suggestForAgent('x', 'claude-haiku-4-5-20251001', neutralPersona, 200_000, {
      scheduledFreqPerDay: 200,
      kanbanOpenCount: 0,
    })
    expect(result.suggestedModel).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
    expect(result.changeAdvised).toBe(true)
  })

  it('mcpServerCount below threshold (3) does not add opus signal point', () => {
    const result = suggestForAgent('x', 'claude-sonnet-5', neutralPersona, 0, {
      mcpServerCount: 3,
    })
    expect(result.suggestedModel).toBe('claude-sonnet-5')
  })

  it('kanbanUrgentCount below threshold (1) does not add opus signal point', () => {
    const result = suggestForAgent('x', 'claude-sonnet-5', neutralPersona, 0, {
      kanbanUrgentCount: 1,
    })
    expect(result.suggestedModel).toBe('claude-sonnet-5')
  })

  it('tokenAvgInputPerCall at threshold boundary (exactly 10K) does not trigger', () => {
    const result = suggestForAgent('x', 'claude-sonnet-5', neutralPersona, 0, {
      tokenAvgInputPerCall: 10_000,
    })
    expect(result.suggestedModel).toBe('claude-sonnet-5')
  })
})

describe('suggestForAgent -- reason structure (6 sections)', () => {
  it('reason contains all 6 sections when signals provided', () => {
    const text = 'IT architekt. Komplex elosztott rendszerterv, mikroszolgáltatás, stratégiai döntések.'
    const result = suggestForAgent('rick', 'claude-sonnet-5', text, 0, {
      tokenAvgInputPerCall: 12_000,
      kanbanOpenCount: 3,
      kanbanUrgentCount: 2,
      scheduledFreqPerDay: 2,
      mcpServerCount: 6,
    })
    expect(result.reason).toMatch(/Jelenlegi modell/)
    expect(result.reason).toMatch(/Megfigyelt használat/)
    expect(result.reason).toMatch(/Szempont-értékelés/)
    expect(result.reason).toMatch(/Ajánlás/)
    expect(result.reason).toMatch(/Becsült költséghatás/)
    expect(result.reason).toMatch(/Bizonytalanság/)
  })

  it('reason section 6 lists missing signals as uncertainty', () => {
    const result = suggestForAgent('x', 'claude-sonnet-5', 'Általános.', 0, {})
    expect(result.reason).toMatch(/token-adat hiányzik/)
    expect(result.reason).toMatch(/kanban-adat hiányzik/)
    expect(result.reason).toMatch(/ütemezési adat hiányzik/)
    expect(result.reason).toMatch(/MCP-konfig hiányzik/)
  })

  it('reason section 6 confirms full coverage when all signals present', () => {
    const result = suggestForAgent('x', 'claude-sonnet-5', 'Általános.', 0, {
      tokenAvgInputPerCall: 5_000,
      kanbanOpenCount: 1,
      kanbanUrgentCount: 0,
      scheduledFreqPerDay: 3,
      mcpServerCount: 2,
    })
    expect(result.reason).toMatch(/minden szempont adattal alátámasztott/)
  })

  it('cost section shows cheaper direction when switching to Haiku', () => {
    const haikuPersona = 'Sport, edzés, futás, kerékpár, úszás, tréner.'
    const result = suggestForAgent('peter', 'claude-opus-4-8[1m]', haikuPersona, 0, {
      scheduledFreqPerDay: 48,
      kanbanOpenCount: 0,
      kanbanUrgentCount: 0,
      mcpServerCount: 1,
      tokenAvgInputPerCall: 500,
    })
    expect(result.suggestedModel).toBe('claude-haiku-4-5-20251001')
    expect(result.reason).toMatch(/olcsóbb/)
  })
})

// MODELSUGGEST807: the migration missed this customer-facing surface -- the
// suggester kept recommending claude-opus-4-8[1m] (measured on the live
// endpoint: 6 of 10 agents advised to DOWNGRADE, 5 of them on Opus 5).
describe('MODELSUGGEST807 -- top tier is the shipped distribution default', () => {
  it('the constant this suite locks to is Opus 5 (1M) today', () => {
    expect(DISTRIBUTION_DEFAULT_AGENT_MODEL).toBe('claude-opus-5[1m]')
  })

  it('an agent already ON the distribution default is never advised to change tier upward', () => {
    const r = suggestForAgent('archie', DISTRIBUTION_DEFAULT_AGENT_MODEL,
      'senior architect, komplex elosztott rendszerek koordinálása, multi-agent')
    expect(r.suggestedModel).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
    expect(r.changeAdvised).toBe(false)
  })

  it('the >150k context override recommends the distribution default, not a downgrade', () => {
    const r = suggestForAgent('bigctx', DISTRIBUTION_DEFAULT_AGENT_MODEL, 'anything', 180_000)
    expect(r.suggestedModel).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
    expect(r.changeAdvised).toBe(false)
  })

  it('no reason text ever names Opus 4.8 as the recommendation', () => {
    for (const [persona, ctx] of [
      ['senior architect koordinál komplex multi-agent', 0],
      ['anything', 200_000],
      ['általános ágens', 0],
    ] as Array<[string, number]>) {
      const r = suggestForAgent('probe', 'claude-opus-5[1m]', persona, ctx)
      expect(r.reason).not.toMatch(/Opus 4\.8 ajánlott/)
      expect(r.suggestedModel).not.toContain('opus-4-8')
    }
  })

  it('humanModelLabel derives the prose label from the model id', () => {
    expect(humanModelLabel('claude-opus-5[1m]')).toBe('Opus 5 (1M)')
    expect(humanModelLabel('claude-sonnet-5')).toBe('Sonnet 5')
  })
})
