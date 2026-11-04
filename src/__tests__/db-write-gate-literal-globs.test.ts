// INSTRFILES1104 A (Samu 69747/69755, Dani 69753): two refinements of how the db-write-gate reads a glob in a Bash
// command, so the next PR's instruction-file entries do not deny everyday work (7-day replay: 596 of 647 new denies
// were a heredoc body's `*`).
// 1. When no program in the command re-runs text as shell code, the shell expands no glob inside quotes or in a heredoc
//    body: their glob words (other than a word of glob characters only, whose quoted form keeps the #2514 rule) are
//    read as the literal names they are. The python and node families count as re-shelling only when the command
//    shows a call that hands text to a shell (os.system, subprocess, child_process, execSync, shell=True, ...); a
//    heredoc or -c fed to a shell, or piped into one, keeps the strict reading.
// 2. A cd joined to the next command by ";", "||" or a newline may fail; the next commands are then judged in the old
//    directory too (the stricter decides). A cd joined by "&&" moves the base alone.
// The decision function only reads paths: nothing here writes a real config.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, literalQuotedGlobs, literalHeredocBody, reShellsText } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
let agent: string
let away: string
let savedHome: string | undefined
let home: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'literal-globs-')))
  root = join(base, 'Install')
  agent = join(root, 'agents', 'samu')
  away = join(base, 'away')
  home = join(base, 'home')
  for (const d of [join(agent, '.claude-config'), join(root, 'store'), away, join(home, '.claude')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(agent, '.mcp.json'), '{}')
  writeFileSync(join(home, '.claude', 'settings.json'), '{}')
  savedHome = process.env.HOME
  process.env.HOME = home
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(base, { recursive: true, force: true })
})

const FREE = { deny: false }
const run = (command: string, cwd = agent) => gateDecision('Bash', { command: command.replaceAll('@H@', home).replaceAll('@AWAY@', away) },
  { cwd, root, subAgent: true, projectDir: agent, configDir: join(agent, '.claude-config') })

describe('1. a glob in quoted code or a heredoc body that goes to no shell is a literal name', () => {
  it.each([
    "python3 - <<'PY'\nimport glob\nfor p in glob.glob('@H@/.claude/*'):\n    print(p)\nPY",
    "python3 - <<'PY'\ns = open('ChatView.kt').read()\ns = s.replace('/** old */', '/** new */')\nPY",
    'python3 -c "import glob; print(glob.glob(\'@H@/.claude/set*\'))"',
    "node -e \"console.log('@H@/.claude/*')\"",
    "cat > notes.md <<'EOF'\nsee @H@/.claude/* and @H@/**\nEOF",
    "cd @AWAY@ && python3 - <<'PY'\np = 'x.kt'\ns = open(p).read().replace('*/', '*/\\n')\nPY",
  ])('free: %s', (c) => { expect(run(c)).toEqual(FREE) })

  it.each([
    // a shell runs the text: the strict reading stays
    "bash <<EOF\ntee @H@/.claude/set*\nEOF",
    "cat <<'EOF' | bash\ntee @H@/.claude/set*\nEOF",
    "printf 'tee @H@/.claude/set*' | sh",
    "bash -c 'tee @H@/.claude/set*'",
    // the interpreter's code hands text to a shell
    "python3 - <<'PY'\nimport os\nos.system('tee @H@/.claude/set*')\nPY",
    'python3 -c "import subprocess; subprocess.run(\'tee @H@/.claude/set*\', shell=True)"',
    "node -e \"require('child_process').execSync('tee @H@/.claude/set*')\"",
    // a literal protected name is still a name
    "python3 -c \"open('@H@/.claude/settings.json', 'w')\"",
    "python3 - <<'PY'\nopen('@H@/.claude/settings.json', 'w').write('{}')\nPY",
    // an unquoted glob, and a body or a span holding a command substitution (it runs)
    'echo x | tee @H@/.claude/set*',
    'python3 - <<EOF\n$(tee @H@/.claude/set*)\nEOF',
    'python3 -c "$(tee @H@/.claude/set*)"',
    // perl and the other interpreters keep the strict reading
    "perl -e 'print \"@H@/.claude/set*\"'",
  ])('denied: %s', (c) => { expect(run(c).deny).toBe(true) })

  it('a word of glob characters only keeps the #2514 rule (quoted count(*) free in the own dir only)', () => {
    expect(run('sqlite3 -readonly /x/y.db "SELECT count(*) FROM t"')).toEqual(FREE)
    expect(literalQuotedGlobs('x "count(*)" \'a/*\' y*')).toBe('x "count(*)" \'a/_\' y*')
    expect(literalHeredocBody('a/* b\n*\n$(ls *)')).toBe('a/* b\n*\n$(ls *)')
    expect(literalHeredocBody('a/* b\n*')).toBe('a/_ b\n*')
    expect(literalQuotedGlobs('"x/*" "unterminated')).toBe('"x/*" "unterminated')
    expect(literalQuotedGlobs('"$(ls x/*)"')).toBe('"$(ls x/*)"')
  })

  it('reShellsText: a heredoc body that calls a shell from python re-shells; one that only reads does not', () => {
    expect(reShellsText("python3 - <<'PY'\nimport os\nos.popen('ls')\nPY")).toBe(true)
    expect(reShellsText("python3 - <<'PY'\nprint(open('a').read())\nPY")).toBe(false)
  })

  // Samu 69768 / Dani 69775: a hidden call (a name built at run time) is a shell call too (fail closed)
  it.each([
    "python3 -c \"__import__('os').system('x')\"",
    "python3 -c \"import importlib; importlib.import_module('o' + 's')\"",
    "python3 -c \"import builtins; builtins.eval('1')\"",
    "python3 -c \"import ctypes\"",
    "python3 -c \"getattr(m, 'sys' + 'tem')('x')\"",
    "python3 -c \"eval('1')\"",
    "python3 -c \"exec('x = 1')\"",
    "python3 -c \"compile('x', 'f', 'exec')\"",
    "node -e \"new Function('return 1')()\"",
    "node -e \"Function('return 1')()\"",
    "node -e \"require('vm').runInThisContext('1')\"",
    "node -e \"process.binding('spawn_sync')\"",
    "node -e \"require(name)\"",
    "node -e \"require('child_' + 'process')\"",
    "node -e \"import(m).then(x => x)\"",
  ])('a hidden call re-shells: %s', (c) => { expect(reShellsText(c)).toBe(true) })

  it.each([
    "python3 - <<'PY'\nimport re\nrx = re.compile(r'x')\ns = open('a.kt').read().replace('/** a */', '/** b */')\nPY",
    "node -e \"const fs = require('fs'); console.log(/x/.test('y'))\"",
    "node -e \"import('fs').then(m => m)\"",
    "python3 -c \"import json; print(json.dumps({'a': 1}))\"",
  ])('no shell call, no hidden call: %s', (c) => { expect(reShellsText(c)).toBe(false) })

  // Dani's review of e53c1080 (69850): the reverse rule. Any reference to a module that can start a process, or to a
  // reflection handle, keeps the strict reading, whatever is done with it.
  it.each([
    "python3 -c \"from os import system; system('tee @H@/.claude/set*')\"",
    "python3 -c \"from os import popen as p; p('tee @H@/.claude/set*')\"",
    "python3 -c \"import os; __builtins__.getattr(os, 'sys' + 'tem')('tee @H@/.claude/set*')\"",
    "python3 -c \"import os; vars(os)['sys' + 'tem']('tee @H@/.claude/set*')\"",
    "python3 -c \"import os; os.__dict__['system']('tee @H@/.claude/set*')\"",
    "python3 -c \"import asyncio; asyncio.run(asyncio.create_subprocess_shell('tee @H@/.claude/set*'))\"",
    "python3 -c \"import multiprocessing\"; tee \"@H@/.claude/set*\"",
    "python3 -c \"g = globals(); x = '@H@/.claude/set*'\"",
    "python3 -c \"[c for c in ().__class__.__bases__[0].__subclasses__()]; '@H@/.claude/set*'\"",
    "node -e \"globalThis.process.mainModule; '@H@/.claude/set*'\"",
    // os reached through another module, a loader that runs what it is handed, the module table
    "python3 -c \"import shutil; shutil.os.system('tee @H@/.claude/set*')\"",
    "python3 -c \"import shutil; f = shutil.os; f.popen('tee @H@/.claude/set*')\"",
    "python3 -c \"import pickle; pickle.loads(b); '@H@/.claude/set*'\"",
    "python3 -c \"import sys; sys.modules['o' + 's']; '@H@/.claude/set*'\"",
    "python3 -c \"import platform; platform.system(); '@H@/.claude/set*'\"",
    // a heredoc body written to a file that the same command then runs is shell code (laterRuns)
    "cat > /tmp/lg-x.sh <<'EOF'\necho x > @H@/.claude/settings.js*\nEOF\nchmod +x /tmp/lg-x.sh && /tmp/lg-x.sh",
    "cat > /tmp/lg-x.sh <<'EOF'\necho x > @H@/.claude/settings.js*\nEOF\nbash /tmp/lg-x.sh",
  ])('the reverse rule, denied: %s', (c) => { expect(run(c).deny).toBe(true) })

  it('a reference to os, posix, subprocess, pty, commands, platform, multiprocessing, asyncio or child_process re-shells', () => {
    for (const m of ['os', 'posix', 'subprocess', 'pty', 'commands', 'platform', 'multiprocessing', 'asyncio', 'pickle', 'runpy', 'webbrowser']) {
      expect(reShellsText(`python3 -c "import ${m}"`)).toBe(true)
      expect(reShellsText(`python3 -c "from ${m} import x"`)).toBe(true)
    }
    expect(reShellsText("node -e \"require('child_process')\"")).toBe(true)
    expect(reShellsText("node -e \"require('node:child_process')\"")).toBe(true)
    // a name that only contains one of them is no reference
    expect(reShellsText('python3 -c "import osmosis, cosmos; x.os_name; macOS"')).toBe(false)
    // an everyday word that only names such a module counts when imported
    expect(reShellsText('python3 -c "print(\'the platform runs commands as code\')"')).toBe(false)
  })

  it('the #2514 rows stay denied (a visible or hidden shell call with a glob)', () => {
    expect(run("python3 -c \"import os; os.system('echo x | tee @H@/.claude/set*')\"").deny).toBe(true)
    expect(run("python3 -c \"__import__('os').system('tee @H@/.claude/set*')\"").deny).toBe(true)
    expect(run("node -e \"require('child_' + 'process').execSync('tee @H@/.claude/set*')\"").deny).toBe(true)
    expect(run("python3 - <<'PY'\nimport re\nrx = re.compile(r'@H@/.claude/*')\nPY")).toEqual(FREE)
  })
})

describe('2. a cd that may fail: the next commands are judged in the old directory too', () => {
  it.each([
    'cd /nonexistent-literal-globs; echo x > .mcp.json',
    'cd @AWAY@; echo x > .mcp.json',
    'cd @AWAY@ || echo x > .mcp.json',
    'cd @AWAY@\necho x > .mcp.json',
    '(cd /nonexistent-literal-globs; echo x > .mcp.json)',
    'cd @AWAY@; true; cp /tmp/x.json .mcp.json',
    // a subshell's cd ends with it: the old directory comes back as the second base after its ")"
    'cd /nonexistent-literal-globs; (cd @AWAY@ && true); echo x > .mcp.json',
  ])('denied: %s', (c) => { expect(run(c).deny).toBe(true) })

  it.each([
    'cd @AWAY@ && echo x > .mcp.json',
    'cd @AWAY@; cd @AWAY@ && echo x > .mcp.json',
    '(cd @AWAY@; true); cd @AWAY@ && echo x > .mcp.json',
  ])('free: %s', (c) => { expect(run(c)).toEqual(FREE) })
})
