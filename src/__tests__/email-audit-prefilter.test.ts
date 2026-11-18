import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// EMAILAUDIT1109 (card 7df70b2e): email-audit-capture.py runs on a '*' matcher,
// so it starts for EVERY tool call. To keep that cheap it exits before importing
// anything when the tool name holds none of six mail-ish words (measured on the
// live host: 44 ms with the imports, 17 ms with the prefilter, 6 ms for a bare
// interpreter start).
//
// A prefilter is a second, cheaper classifier, and a cheap classifier that is
// NARROWER than the real one is exactly the bug the mail gates were measured to
// have: a name-based filter the Google Workspace tool names slipped past. So the
// prefilter must be a strict SUPERSET of classify_mail_tool, and that is not a
// claim to make by reading the word list -- it is checked here against the
// shared case matrix the gates already pin
// (scripts/hooks/mail-tool-name-cases.json), so a new tool name added for the
// gates turns this red if the prefilter would drop it.
const ROOT = join(__dirname, '..', '..')
const HOOKS = join(ROOT, 'scripts', 'hooks')

type Verdict = { name: string; kind: string | null; prefilter: boolean }

function verdicts(): Verdict[] {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(HOOKS)})
import email_extract as E
spec = importlib.util.spec_from_file_location('eac', ${JSON.stringify(join(HOOKS, 'email-audit-capture.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

cases = json.load(open(${JSON.stringify(join(HOOKS, 'mail-tool-name-cases.json'))}))
names = set()
def walk(o):
    if isinstance(o, dict):
        for v in o.values(): walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
    elif isinstance(o, str) and '_' in o:
        names.add(o)
walk(cases)
print(json.dumps([
    {'name': n, 'kind': E.classify_mail_tool(n), 'prefilter': bool(m._maybe_mail_tool(n))}
    for n in sorted(names)
]))
`], { encoding: 'utf-8', cwd: ROOT })
  return JSON.parse(out) as Verdict[]
}

describe('email-audit-capture prefilter vs classify_mail_tool', () => {
  const rows = verdicts()

  it('the shared case matrix actually yields both kinds of name', () => {
    // Positive control: without mail names here the superset assertion below
    // would pass vacuously, and without non-mail names the prefilter would be
    // untested as a FILTER (a function returning true for everything also
    // satisfies "superset").
    const mail = rows.filter(r => r.kind !== null)
    const notMail = rows.filter(r => r.kind === null)
    expect(mail.length, 'no classify-positive names in the case matrix').toBeGreaterThan(10)
    expect(notMail.length, 'no classify-negative names in the case matrix').toBeGreaterThan(10)
  })

  it('lets through EVERY name classify_mail_tool calls mail', () => {
    const dropped = rows.filter(r => r.kind !== null && !r.prefilter).map(r => r.name)
    expect(
      dropped,
      `the prefilter is narrower than the classifier -- these sends would never be audited: ${dropped.join(', ')}`,
    ).toEqual([])
  })

  it('still filters: it rejects plain non-mail tool names', () => {
    const cheap = ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebFetch', 'TodoWrite']
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(HOOKS)})
spec = importlib.util.spec_from_file_location('eac', ${JSON.stringify(join(HOOKS, 'email-audit-capture.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps({n: bool(m._maybe_mail_tool(n)) for n in ${JSON.stringify(cheap)}}))
`], { encoding: 'utf-8', cwd: ROOT })
    expect(JSON.parse(out)).toEqual(Object.fromEntries(cheap.map(n => [n, false])))
  })

  it('always lets Bash through -- its command text decides, not its name', () => {
    const out = execFileSync('python3', ['-c', `
import importlib.util, sys
sys.path.insert(0, ${JSON.stringify(HOOKS)})
spec = importlib.util.spec_from_file_location('eac', ${JSON.stringify(join(HOOKS, 'email-audit-capture.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print('yes' if m._maybe_mail_tool('Bash') else 'no')
`], { encoding: 'utf-8', cwd: ROOT }).trim()
    expect(out).toBe('yes')
  })
})

describe('email-audit-capture is wired for all three events', () => {
  // The intent half is useless if it runs AFTER the gate that blocks the send:
  // a blocked call fires no PostToolUse, so the attempt would leave no trace at
  // all. Hence first entry, and on the failure event too.
  for (const file of ['.claude/settings.json', 'templates/settings.json.template']) {
    const settings = JSON.parse(readFileSync(join(ROOT, file), 'utf-8')) as {
      hooks?: Record<string, { matcher?: string; hooks?: { command?: string }[] }[]>
    }
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      it(`${file}: ${event} runs the capture hook FIRST`, () => {
        const entries = settings.hooks?.[event] ?? []
        expect(entries.length, `${file} has no ${event} entries`).toBeGreaterThan(0)
        const first = JSON.stringify(entries[0])
        expect(first).toContain('email-audit-capture.py')
      })
    }
  }
})
