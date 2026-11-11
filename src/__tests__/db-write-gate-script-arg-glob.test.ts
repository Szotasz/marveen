// GATESCRIPTARG1111 (Samu 75780 A, Boni 75773, Marveen 75775): since GATEFILES1110 (#2681) a sub-agent's own directory
// holds a protected name without a leading dot (agents/*/agent-config.json, noBareGlob), and a python/node SCRIPT FILE
// run counted as re-shelling, so its quoted `count(*)` argument was read as a bare glob there and denied a read-only
// measurement (`python3 scripts/supabase-logs.py <ref> "select count(*) ..."`). The shell never expands a glob in
// quotes and the script's own code is not seen by the gate anyway, so that argument is data now, as for sqlite3.
// Inline code, the shell family, bun/deno and an UNQUOTED glob stay strict.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, scriptFileRun, reShellText } from '../../scripts/hooks/db-write-gate.mjs'
// @ts-expect-error -- plain .mjs module, no types
import { shellWords } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
let agent: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'script-arg-glob-')))
  root = join(base, 'Install')
  agent = join(root, 'agents', 'boni')
  mkdirSync(join(root, 'store'), { recursive: true })
  mkdirSync(join(root, 'agents', 'qwen'), { recursive: true })
  mkdirSync(join(agent, 'work'), { recursive: true })
  for (const d of [agent, join(root, 'agents', 'qwen')]) writeFileSync(join(d, 'agent-config.json'), '{"model":"x"}')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

// a sub-agent in its OWN directory: the place where a bare `*` reaches agent-config.json
const run = (command: string) => gateDecision('Bash', { command }, { cwd: agent, root, subAgent: true, projectDir: agent })
const FREE = { deny: false }

const BONI = `python3 /x/scripts/supabase-logs.py ymljpjpjrwbmkfvtahtn "select count(*) c from logs where source = 'function_logs' and event_message like '%Looking up tax number%'" --hours 24 --vault-key MARVEEN-CONNECTORS-PAT`

describe('a quoted argument of a python/node script file is data', () => {
  it.each([
    ['Boni\'s read-only measurement (75773), as sent', BONI],
    ['select *', 'python3 /x/s.py "select * from logs limit 1" --hours 24'],
    ['single quotes', "python3 /x/s.py 'count(*)'"],
    ['the harmless python flags before the script', 'python3 -I -S /x/s.py "count(*)"'],
    ['a versioned python', 'python3.12 /x/s.py "*"'],
    ['a system-dir python', '/usr/bin/python3 /x/s.py "*"'],
    ['node', 'node /x/s.mjs "count(*)"'],
    ['a relative script', 'python3 work/s.py "count(*)"'],
    ['next to a read in the same command', 'python3 /x/s.py "count(*)" && cat work/out.txt'],
  ])('%s', (_label, command) => {
    expect(run(command)).toEqual(FREE)
  })
})

describe('what stays strict', () => {
  it.each([
    ['an UNQUOTED glob (the shell expands it before the script starts)', 'python3 /x/s.py *'],
    ['an unquoted glob next to a quoted one', 'python3 /x/s.py "count(*)" *'],
    ['inline python that hands text to a shell', `python3 -c "import os; os.system('cp /tmp/evil.json *')"`],
    ['inline node that hands text to a shell', `node -e "require('child_process').execSync('cp /tmp/evil.json *')"`],
    ['a shell script', 'bash /x/s.sh "*"'],
    ['sh -c', `sh -c 'cp /tmp/evil.json *'`],
    ['a script run piped into a shell', 'python3 /x/s.py "*" | sh'],
    ['bun (its run goes to package scripts)', 'bun /x/s.ts "*"'],
    ['python -m', 'python3 -m somemod "*"'],
    ['an option python does not get here', 'python3 -X dev /x/s.py "*"'],
    ['a $ word (the shell splits and globs it)', 'python3 /x/s.py $Q "*"'],
    ['a heredoc body a script reads (it may run it as shell code)', "python3 /x/s.py <<'EOF'\ncp /tmp/evil.json *\nEOF"],
    ['a python-only flag before a node script', 'node -s /x/s.mjs "*"'],
    ['GATEFILES1110: cp into the own dir with a bare glob', 'cp /tmp/evil.json *'],
    ['GATEFILES1110: the zsh qualifier form', 'cp x *(od[1])'],
  ])('%s', (_label, command) => {
    expect(run(command).deny).toBe(true)
  })

  it('a protected path handed to a script is still denied: only the glob characters became data', () => {
    expect(run('python3 /x/s.py agent-config.json').deny).toBe(true)
    expect(run('python3 /x/s.py "agent-config.json"').deny).toBe(true)
    expect(run(`python3 /x/s.py ${join(root, 'agents', 'qwen', 'agent-config.json')}`).deny).toBe(true)
    expect(run('node /x/s.mjs ../qwen/agent-config.json').deny).toBe(true)
  })

  it('the same quoted count(*) outside the own directory was and is free (the measured workaround)', () => {
    const cmd = 'python3 /x/s.py "count(*)"'
    expect(gateDecision('Bash', { command: cmd }, { cwd: join(agent, 'work'), root, subAgent: true, projectDir: agent })).toEqual(FREE)
  })
})

describe('scriptFileRun / reShellText', () => {
  const w = (s: string) => shellWords(s)
  it('names only a plain python/node script-file run', () => {
    expect(scriptFileRun(w('python3 /x/s.py "*"'))).toBe(true)
    expect(scriptFileRun(w('python3 -I /x/s.py'))).toBe(true)
    expect(scriptFileRun(w('node s.mjs a'))).toBe(true)
    expect(scriptFileRun(w('python3 -c "print(1)"'))).toBe(false)
    expect(scriptFileRun(w('python3 -'))).toBe(false)
    expect(scriptFileRun(w('python3'))).toBe(false)
    expect(scriptFileRun(w('node -e "1"'))).toBe(false)
    expect(scriptFileRun(w('node --eval "1"'))).toBe(false)
    expect(scriptFileRun(w('python3 /x/*.py'))).toBe(false)
    expect(scriptFileRun(w('python3 /x/s.py $X'))).toBe(false)
    expect(scriptFileRun(w('bash /x/s.sh'))).toBe(false)
    expect(scriptFileRun(w('bun /x/s.ts'))).toBe(false)
    expect(scriptFileRun(w('./python3 /x/s.py'))).toBe(false)
  })
  it('leaves only the script-file runs out of the re-shell text', () => {
    expect(reShellText('python3 /x/s.py "*"', root)).toBe('')
    expect(reShellText('python3 /x/s.py "*" | sh', root)).toContain('sh')
    expect(reShellText('bash /x/s.sh "*"', root)).toBe('bash /x/s.sh "*"')
  })
})
