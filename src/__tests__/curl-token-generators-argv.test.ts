import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { argvTokenHits } from './helpers/curl-commands.js'

// The generators and templates that WRITE curl commands for agents must not put the
// dashboard token on a curl argv (ps-visible). The emitted replacement is the curl-config form
// (the same one #2041 uses in the shell scripts):
//   printf 'header = "Authorization: Bearer %s"\n' "$(cat '<token path>')" | curl -K - ...
// printf is a builtin, so the token never reaches an argv. The one exception is a curl whose body
// is read from stdin (-d @-, --data-binary @- <<'JSON'): stdin is taken, so there the curl config
// comes from a process substitution, -K <(printf ...).
//
// This file is the STATIC half: no generator source may carry the token in a header at all, in any
// spelling. The shape of the emitted commands (stdin rules, quoting) is checked on the RENDERED output,
// and the commands are executed, in curl-token-rendered.test.ts: a regex over source text cannot say
// whether the command it describes works.
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const read = (rel: string) => readFileSync(`${ROOT}/${rel}`, 'utf-8')

const GENERATORS = [
  'src/web/agent-scaffold.ts',
  'src/web/heartbeat-agent-scaffold.ts',
  'src/web/voice-directive.ts',
  'src/web/routes/kanban.ts',
  'src/web/federation/onboarding.ts',
  'src/web/claude-rotation-heartbeat.ts',
  'templates/CLAUDE.md.template',
  'templates/settings.json.template',
  'templates/profiles/researcher.json',
  'templates/profiles/developer-junior.json',
  'scripts/hooks/memory-lookup-nudge.py',
  'scripts/hooks/provenance-gate.py',
  'scripts/kartya-es-ertesites.py',
]

describe('the argv-token detector sees every spelling of the banned form', () => {
  const BAD: Record<string, string> = {
    '-H, double quotes, $(cat)': `curl -s -H "Authorization: Bearer $(cat /x/.dashboard-token)" http://h/api`,
    '--header, double quotes, $VAR': `curl -s --header "Authorization: Bearer $TOKEN" http://h/api`,
    '-H, single quotes, other variable name': `curl -s -H 'Authorization: Bearer \${DASHBOARD_TOKEN}' http://h/api`,
    'JSON-escaped -H': `curl -s -H \\"Authorization: Bearer $(cat x)\\" http://h/api`,
    'python concatenation': `"curl -H 'Authorization: Bearer " + tok + "' http://h/api"`,
    'python f-string': `f'curl -H "Authorization: Bearer {tok}" http://h/api'`,
    'no space after the colon, lower case': `curl -H "authorization:bearer abc" http://h/api`,
    'a permission rule that allows the argv form': `"Bash(curl -s -H \\"Authorization: Bearer $(cat \${PROJECT_ROOT}/store/.dashboard-token)\\" \\"http://localhost:3420/api/*)"`,
  }
  for (const [name, sample] of Object.entries(BAD)) {
    it(`flags: ${name}`, () => {
      expect(argvTokenHits(sample).length).toBeGreaterThan(0)
    })
  }

  const GOOD: Record<string, string> = {
    'the curl config piped in': `printf 'header = "Authorization: Bearer %s"\\n' "$(cat '/x y/.dashboard-token')" | curl -s -K - http://h/api`,
    'the curl config as a process substitution': `curl -s -K <(printf 'header = "Authorization: Bearer %s"\\n' "$(cat x)") -d @- http://h/api`,
    'the curl config inside a JSON string': `\\"$(printf 'header = \\"Authorization: Bearer %s\\"\\\\n' \\"$(cat x)\\")\\"`,
  }
  for (const [name, sample] of Object.entries(GOOD)) {
    it(`accepts: ${name}`, () => {
      expect(argvTokenHits(sample)).toEqual([])
    })
  }
})

describe('generated curl commands keep the dashboard token off argv', () => {
  for (const rel of GENERATORS) {
    it(`${rel} carries the token only inside the printf curl config`, () => {
      const src = read(rel)
      const hits = argvTokenHits(src).map((i) => src.slice(Math.max(0, i - 60), i + 60).replace(/\n/g, ' '))
      expect(hits).toEqual([])
    })
  }

  // The path inside $(cat <path>) must be quoted wherever it carries a variable part. This is the static
  // net for the emitters the rendered test cannot reach (the generateClaudeMd prompt text, the other
  // provenance-gate entry points): putting the bare variable back turns exactly one of these red.
  const UNQUOTED_CAT: Array<[RegExp, string]> = [
    [/\$\(cat \$\{(?!tokenArg\}|shQuote\()/, 'TypeScript: $(cat ${...}) must be ${tokenArg} or ${shQuote(...)}'],
    [/\$\(cat \{(?!shlex\.quote\()/, 'Python: $(cat {...}) must be {shlex.quote(...)}'],
    [/\$\(cat \{\{/, 'template: $(cat {{...}}) must be inside single quotes'],
    [/\$\(cat \$[A-Za-z_]/, 'shell variable path in $(cat $VAR) must be quoted'],
  ]
  for (const rel of GENERATORS) {
    it(`${rel}: no unquoted variable path inside $(cat ...)`, () => {
      const src = read(rel)
      for (const [re, why] of UNQUOTED_CAT) expect(src, `${rel}: ${why}`).not.toMatch(re)
    })
  }

  it('the quoting net itself flags the bare forms (positive control)', () => {
    const bare = ['$(cat ${tokenPath})', '$(cat {token})', '$(cat {{PROJECT_ROOT}}/store/.dashboard-token)', '$(cat $TOKEN_FILE)']
    for (const sample of bare) expect(UNQUOTED_CAT.some(([re]) => re.test(sample)), sample).toBe(true)
    const fine = ['$(cat ${tokenArg})', '$(cat ${shQuote(tokenPath)})', '$(cat {shlex.quote(token)})', "$(cat '{{PROJECT_ROOT}}/store/.dashboard-token')", '$(cat store/.dashboard-token)']
    for (const sample of fine) expect(UNQUOTED_CAT.some(([re]) => re.test(sample)), sample).toBe(false)
  })

  it('the four stdin-body curls (voice tts, rotation heartbeat, autonomy Level 1, sender ping) keep -K <(...)', () => {
    expect(read('src/web/voice-directive.ts')).toContain('-K <(printf')
    expect(read('src/web/claude-rotation-heartbeat.ts')).toContain('-K <(printf')
    expect(read('src/web/agent-scaffold.ts').split('-K <(printf').length - 1).toBe(2)
  })

  it('no other generator uses the process-substitution form', () => {
    for (const rel of GENERATORS) {
      if (['src/web/voice-directive.ts', 'src/web/claude-rotation-heartbeat.ts', 'src/web/agent-scaffold.ts'].includes(rel)) continue
      expect(read(rel), rel).not.toContain('-K <(')
    }
  })
})
