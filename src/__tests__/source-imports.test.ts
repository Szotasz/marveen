import { describe, it, expect } from 'vitest'
import { importsValueBinding } from './setup/source-imports.js'

// The shared import assertion is test infrastructure, so it carries its own
// both-direction cases: if it answered `true` too easily, every suite using it
// would stay green with the defence gone -- a formality that reassures by being
// present. Lifted out of prompt-injection-defense.test.ts with the helper
// (TESZTIMPORTUTIL922), unchanged, and extended for the two-symbol case the
// onboarding suite needs.

// The relaxed check is itself test infrastructure: if it answered `true` too
// easily, the assertion above would stay green with the defence gone -- a
// formality that reassures by being present. These cases pin both directions.
describe('importsValueBinding (the relaxed import check itself, IMPORTKAPULAZ921)', () => {
  const M = '../agent-config.js'

  it('accepts the plain import', () => {
    expect(importsValueBinding("import { isKnownAgent } from '../agent-config.js'", 'isKnownAgent', M)).toBe(true)
  })

  it('accepts a co-import -- the exact shape that misfired on #1448', () => {
    expect(importsValueBinding("import { isKnownAgent, readAgentPullDelivery } from '../agent-config.js'", 'isKnownAgent', M)).toBe(true)
  })

  it('accepts the binding in any position and over several lines', () => {
    const src = "import {\n  readAgentPullDelivery,\n  isKnownAgent,\n} from '../agent-config.js'"
    expect(importsValueBinding(src, 'isKnownAgent', M)).toBe(true)
  })

  it('rejects a missing import -- this is what keeps it a gate', () => {
    expect(importsValueBinding("import { readAgentPullDelivery } from '../agent-config.js'", 'isKnownAgent', M)).toBe(false)
  })

  it('rejects the same name imported from a DIFFERENT module', () => {
    expect(importsValueBinding("import { isKnownAgent } from '../somewhere-else.js'", 'isKnownAgent', M)).toBe(false)
  })

  it('rejects a type-only import: erased at runtime, so the guard is not there', () => {
    expect(importsValueBinding("import type { isKnownAgent } from '../agent-config.js'", 'isKnownAgent', M)).toBe(false)
    expect(importsValueBinding("import { type isKnownAgent } from '../agent-config.js'", 'isKnownAgent', M)).toBe(false)
  })

  it('rejects a name that merely CONTAINS the binding', () => {
    expect(importsValueBinding("import { isKnownAgentCached } from '../agent-config.js'", 'isKnownAgent', M)).toBe(false)
  })

  it('does not read an unrelated mention in prose or a comment as an import', () => {
    expect(importsValueBinding('// isKnownAgent lives in ../agent-config.js\nconst x = 1', 'isKnownAgent', M)).toBe(false)
  })
})
