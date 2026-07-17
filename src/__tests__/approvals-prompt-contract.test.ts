// String-contract guard for the approval wiring in agent-scaffold.ts.
// Verifies that buildAutonomyBody() contains the correct autonomy rules and
// API endpoints so that every generated/updated agent CLAUDE.md carries the
// right instructions.
//
// Pattern: read agent-scaffold.ts as a string and assert short,
// formatting-proof fragments (same "house idiom" as
// approvals-ui-contract.test.ts / federation-ui-contract.test.ts).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAFFOLD = readFileSync(join(__dirname, '../../src/web/agent-scaffold.ts'), 'utf-8')

// Slice the buildAutonomyBody function body -- assertions must land inside the
// function definition, not anywhere else in the 800-line file.
const fnStart = SCAFFOLD.indexOf('function buildAutonomyBody(')
const fnEnd   = SCAFFOLD.indexOf('\n// Idempotently ensures the autonomy-wiring', fnStart)
const AUTONOMY_FN = SCAFFOLD.slice(fnStart, fnEnd)

describe('agent-scaffold.ts buildAutonomyBody: approval wiring content', () => {
  it('autonomy section header is in the function body', () => {
    expect(AUTONOMY_FN).toContain('## Autonómia és jóváhagyás')
  })

  it('references autonomy-config.json so agents know where to read the level', () => {
    expect(AUTONOMY_FN).toContain('autonomy-config.json')
  })

  it('level 1 rule says notify and stop -- not queue an approval', () => {
    expect(AUTONOMY_FN).toMatch(/Level 1[^*]*csak jelez/)
    expect(AUTONOMY_FN).toContain('ÁLLJ MEG')
    // Level 1 block: from Level 1 to Level 2 must NOT call /api/approvals
    const level1Block = AUTONOMY_FN.slice(
      AUTONOMY_FN.indexOf('Level 1'),
      AUTONOMY_FN.indexOf('Level 2'),
    )
    expect(level1Block).not.toContain('/api/approvals')
  })

  it('level 2 rule instructs POST /api/approvals before acting', () => {
    expect(AUTONOMY_FN).toMatch(/Level 2[^*]*jóváhagyás/)
    const level2Block = AUTONOMY_FN.slice(
      AUTONOMY_FN.indexOf('Level 2'),
      AUTONOMY_FN.indexOf('Level 3'),
    )
    expect(level2Block).toContain('/api/approvals')
    expect(level2Block).toContain('POST')
  })

  it('level 2 includes GET polling for the approval decision', () => {
    const level2Block = AUTONOMY_FN.slice(
      AUTONOMY_FN.indexOf('Level 2'),
      AUTONOMY_FN.indexOf('Level 3'),
    )
    expect(level2Block).toContain('GET')
    expect(level2Block).toContain('/api/approvals/<id>')
    expect(level2Block).toMatch(/status=approved/)
    expect(level2Block).toMatch(/status=rejected/)
  })

  it('level 3 means act then report -- no approval API call', () => {
    expect(AUTONOMY_FN).toMatch(/Level 3[^*]*autonóm/)
    const level3Block = AUTONOMY_FN.slice(AUTONOMY_FN.indexOf('Level 3'))
    // Within a short window after "Level 3" there must be no approval API call
    const level3Snippet = level3Block.slice(0, 300)
    expect(level3Snippet).not.toContain('/api/approvals')
  })

  it('approval request uses the agent name parameter, not a hardcoded id', () => {
    // The buildAutonomyBody function receives `name` and must embed it via
    // template interpolation -- not a literal placeholder like AGENT_NAME.
    // A literal ${name} would appear as \${name} in source due to escaping;
    // what matters is that the function takes a parameter and uses it.
    expect(AUTONOMY_FN).toContain('name: string')
    // The curl line for /api/approvals must reference the name parameter, not
    // the string "AGENT_NAME" (which would be a stale placeholder from the old
    // LLM-prompt approach that didn't resolve the actual agent name).
    const postCurl = AUTONOMY_FN.slice(AUTONOMY_FN.indexOf('/api/approvals'), AUTONOMY_FN.indexOf('/api/approvals') + 300)
    expect(postCurl).not.toContain('"AGENT_NAME"')
  })

  it('AUTONOMY_BEGIN and AUTONOMY_END markers are defined and used in generateClaudeMd', () => {
    expect(SCAFFOLD).toContain("const AUTONOMY_BEGIN = '<!-- BEGIN GENERATED: autonomy-wiring")
    expect(SCAFFOLD).toContain("const AUTONOMY_END = '<!-- END GENERATED: autonomy-wiring -->'")
    // generateClaudeMd must append the autonomy section with markers after LLM output
    const genFn = SCAFFOLD.slice(SCAFFOLD.indexOf('async function generateClaudeMd('))
    expect(genFn).toContain('AUTONOMY_BEGIN')
    expect(genFn).toContain('buildAutonomyBody(name)')
    expect(genFn).toContain('AUTONOMY_END')
  })

  it('ensureAutonomySection is exported and calls atomicWriteFileSync', () => {
    expect(SCAFFOLD).toContain('export function ensureAutonomySection(')
    expect(SCAFFOLD).toContain('atomicWriteFileSync')
  })
})
