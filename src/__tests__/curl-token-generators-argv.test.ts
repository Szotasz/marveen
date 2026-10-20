import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// The generators and templates that WRITE curl commands for agents must not put the
// dashboard token on a curl argv (ps-visible). The forms that emit it are banned here; the
// emitted replacement is the curl-config form (the same one #2041 uses in the shell scripts):
//   printf 'header = "Authorization: Bearer %s"\n' "$(cat <token>)" | curl -K - ...
// printf is a builtin, so the token never reaches an argv. The one exception is a curl whose
// body is read from stdin (-d @-, --data-binary @- <<'JSON'): stdin is taken, so the curl
// config comes from a process substitution there, -K <(printf ...).
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

const read = (rel: string) => readFileSync(`${ROOT}/${rel}`, 'utf-8')

// The text of one curl command after a -K <(...) occurrence: from the end of the process
// substitution up to the next curl, at most 150 chars (a command is shorter than that here).
function afterProcessSubstitution(src: string, at: number): string {
  let depth = 0
  let end = at
  for (let i = at + '-K <'.length; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) { end = i + 1; break }
  }
  return src.slice(end, end + 150).split('curl ')[0]
}

describe('generated curl commands keep the dashboard token off argv', () => {
  for (const rel of GENERATORS) {
    it(`${rel} emits no argv-token curl`, () => {
      expect(read(rel)).not.toMatch(ARGV_TOKEN)
    })

    it(`${rel} uses -K <(...) only where the curl body takes stdin`, () => {
      const src = read(rel)
      let from = 0
      for (;;) {
        const at = src.indexOf('-K <(', from)
        if (at < 0) break
        expect(afterProcessSubstitution(src, at), `${rel} @${at}`).toContain('@-')
        from = at + 1
      }
    })
  }

  // The reverse direction: a curl that takes its config from stdin (-K -) must not ALSO read its
  // body from stdin, or both would wait on the same pipe.
  for (const rel of GENERATORS) {
    it(`${rel}: no curl that reads its config from stdin (-K -) also reads its body from stdin`, () => {
      const src = read(rel)
      let from = 0
      for (;;) {
        const at = src.indexOf('-K - ', from)
        if (at < 0) break
        const command = src.slice(at, at + 200).split('curl ')[0]
        expect(command, `${rel} @${at}`).not.toMatch(/@-|<<\s*['"\\]?[A-Z]/)
        from = at + 1
      }
    })
  }

  it('the stdin-body curls (voice tts, rotation heartbeat, autonomy Level 1, sender ping) keep -K <(...)', () => {
    expect(read('src/web/voice-directive.ts')).toContain('-K <(printf')
    expect(read('src/web/claude-rotation-heartbeat.ts')).toContain('-K <(printf')
    const scaffold = read('src/web/agent-scaffold.ts')
    expect(scaffold.split('-K <(printf').length - 1).toBe(2)
  })

  it('the emitted form elsewhere is printf | curl -K - (the #2041 curl-config form)', () => {
    const kanban = read('src/web/routes/kanban.ts')
    expect(kanban).toContain('printf \'header = "Authorization: Bearer %s"\\\\n\' "$(cat ${tokenPath})"')
    expect(kanban).toContain("const auth = '-K -'")
    expect(kanban).toMatch(/\$\{tokenCfg\} \| curl -s/)
    const template = read('templates/CLAUDE.md.template')
    expect(template).toMatch(/printf 'header = "Authorization: Bearer %s"\\n' "\$\(cat store\/\.dashboard-token\)" \| curl -s/)
    expect(template).not.toContain('-K <(')
  })
})
