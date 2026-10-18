import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// The generators and templates that WRITE curl commands for agents must not put the
// dashboard token on a curl argv (ps-visible). The forms that emit it are banned here; the
// emitted replacement is the curl-config form, token read by $(cat ...) inside a printf builtin.
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const GENERATORS = [
  'src/web/agent-scaffold.ts',
  'src/web/heartbeat-agent-scaffold.ts',
  'src/web/voice-directive.ts',
  'src/web/routes/kanban.ts',
  'src/web/federation/onboarding.ts',
  'src/web/claude-rotation-heartbeat.ts',
  'templates/CLAUDE.md.template',
  'templates/settings.json.template',
  'scripts/hooks/memory-lookup-nudge.py',
  'scripts/hooks/provenance-gate.py',
  'scripts/kartya-es-ertesites.py',
]

// the token inside a -H header on the curl command line (argv), in any quoting
const ARGV_TOKEN = /-H \\?"Authorization: Bearer (\$\(cat|\$TOKEN|\$\{token\})/

describe('generated curl commands keep the dashboard token off argv', () => {
  for (const rel of GENERATORS) {
    it(`${rel} emits no argv-token curl`, () => {
      const src = readFileSync(`${ROOT}/${rel}`, 'utf-8')
      expect(src).not.toMatch(ARGV_TOKEN)
    })
  }

  it('the emitted form is the curl-config one (printf builtin into -K)', () => {
    const src = readFileSync(`${ROOT}/src/web/routes/kanban.ts`, 'utf-8')
    expect(src).toContain('-K <(printf \'header = "Authorization: Bearer %s"\\\\n\'')
  })
})
