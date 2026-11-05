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
import { gateDecision, literalQuotedGlobs, literalHeredocBody, reShellsText, pythonDataVerdict } from '../../scripts/hooks/db-write-gate.mjs'
import { spawnSync } from 'node:child_process'
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
    "python3 - <<'PY'\ns = open('ChatView.kt').read()\ns = s.replace('/** old */', '/** new */')\nPY",
    'python3 -c "import json; print(json.dumps([\'@H@/.claude/set*\']))"',
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
    // the closed allowlist (Samu 69997, Dani 70000 (5)): python's own pattern API expands the glob without a shell,
    // and node gets no data exception
    "python3 - <<'PY'\nimport glob\nfor p in glob.glob('@H@/.claude/*'):\n    print(p)\nPY",
    'python3 -c "import glob; print(glob.glob(\'@H@/.claude/set*\'))"',
    "node -e \"console.log('@H@/.claude/*')\"",
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
    "python3 -c \"import json; print(json.dumps({'a': 1}))\"",
  ])('no shell call, no hidden call: %s', (c) => { expect(reShellsText(c)).toBe(false) })

  it.each([
    "node -e \"const fs = require('fs'); console.log(/x/.test('y'))\"",
    "node -e \"import('fs').then(m => m)\"",
  ])('node inline code is never data (Samu 69992): %s', (c) => { expect(reShellsText(c)).toBe(true) })

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
    // the builtin reached through an attribute or an optional call (Dani 69945)
    "node -e \"eval?.('x'); '@H@/.claude/set*'\"",
    "node -e \"eval.call(null, 'x'); '@H@/.claude/set*'\"",
    "python3 -c \"exec.__call__('x'); '@H@/.claude/set*'\"",
    "node -e \"global.eval?.('x'); '@H@/.claude/set*'\"",
    "python3 -c \"print.__self__.eval('x'); '@H@/.claude/set*'\"",
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
    // a name that only contains one of them is no reference to it; under the closed allowlist an unlisted module is
    // strict anyway, so a data row holds only listed names
    expect(reShellsText('python3 -c "import osmosis, cosmos; x.os_name; macOS"')).toBe(true)
    expect(reShellsText('python3 -c "import json; d = json.loads(\'{}\'); d.os_name"')).toBe(false)
    // an everyday word that only names such a module counts when imported
    expect(reShellsText('python3 -c "print(\'the platform runs commands as code\')"')).toBe(false)
    // measured on 7 days of calls (Samu 69855): Kotlin import lines and shell text held as DATA in an edit heredoc
    expect(reShellsText("python3 - <<'PY'\ns = 'import androidx.compose.ui.platform.LocalContext'\nPY")).toBe(false)
    expect(reShellsText("python3 - <<'PY'\nline = 'exec python3 run.py \"$@\"'\nPY")).toBe(false)
    // ...while a real import of the module, or a builtin used as a value or called, still re-shells
    expect(reShellsText('python3 -c "import sys, platform"')).toBe(true)
    expect(reShellsText('python3 -c "import platform as p"')).toBe(true)
    for (const c of ['f = exec', 'g(exec)', "exec ('x')", 'h = [eval]', 'k = compile,']) {
      expect(reShellsText(`python3 -c "${c}"`)).toBe(true)
    }
    // Samu 69909 (1): the FIRST segment of a dotted import is the name Python binds, so it counts; a later one does not
    for (const c of ['import os.path', 'import importlib.util', 'import subprocess as s', 'from os.path import join',
      'import platform.x', 'import sys, platform.x', 'from platform.x import y']) {
      expect(reShellsText(`python3 - <<'PY'\n${c}\nPY`)).toBe(true)
    }
    // ...and an import of an unlisted module is strict whatever its name (the closed allowlist, Samu 69992 (1))
    for (const c of ['import androidx.compose.ui.platform.LocalContext', 'import a.b, androidx.platform']) {
      expect(reShellsText(`python3 - <<'PY'\n${c}\nPY`)).toBe(true)
    }
    // Samu 69909 (2): a call through whitespace, a line break, a backslash continuation, or a node tagged template
    for (const c of ['exec (x)', 'exec\t(x)', 'exec\n(x)', 'exec \\\n(x)', 'exec`x`', 'eval `x`']) {
      expect(reShellsText(`python3 - <<'PY'\n${c}\nPY`)).toBe(true)
    }
    // Dani's review of 545c8c2b (69945) and Samu 69948: the name is ALWAYS a sign, except before a space or tab and a
    // word starting with a letter (shell text: `exec python3 ...`) or inside a longer identifier (executor, evaluate)
    expect(reShellsText("node -e \"eval?.('requ' + 'ire')('x')\"")).toBe(true)
    expect(reShellsText("node -e \"eval.call(null, 'x')\"")).toBe(true)
    expect(reShellsText("python3 -c \"exec.__call__('x')\"")).toBe(true)
    // Dani 69959: reached as an attribute, eval and exec are signs too; only .compile is not (re.compile)
    expect(reShellsText("node -e \"global.eval?.('x')\"")).toBe(true)
    expect(reShellsText("python3 -c \"print.__self__.eval('x')\"")).toBe(true)
    expect(reShellsText("python3 -c \"import builtins as b; b.exec('x')\"")).toBe(true)
    expect(reShellsText("python3 -c \"m.exec\"")).toBe(true)
    // Samu 69962: the handles that build a callable from a code object are reflection handles too
    for (const c of ['import types; types.FunctionType(c, {})()', 'from types import FunctionType', 'f.__code__', 'f.__closure__',
      'm.__func__', 'CodeType(1)', 'LambdaType', 'import sys, types', 'import types as t']) {
      expect(reShellsText(`python3 -c "${c}"`)).toBe(true)
    }
    // an everyday "types" in text stays data; an unlisted module is strict whatever its name
    expect(reShellsText(`python3 -c "print('the types of x')"`)).toBe(false)
    for (const c of ['import mypkg.types', 'from x.types import y']) {
      expect(reShellsText(`python3 -c "${c}"`)).toBe(true)
    }
    for (const c of ['exec[0]', 'x = eval', 'eval', 'exec -a n', 'compile;', 'exec\\', 'eval{', 'exec#x', 'eval  \t(x)']) {
      expect(reShellsText(`python3 - <<'PY'\n${c}\nPY`)).toBe(true)
    }
    for (const c of ['executor = 1', 'import re\ncompiled = re.compile(r"x")', 'run_exec = 1', 's = "exec python3 run.py"']) {
      expect(reShellsText(`python3 - <<'PY'\n${c}\nPY`)).toBe(false)
    }
    // the closed allowlist: a free name that is no listed builtin, and code the ast cannot parse, are strict
    for (const c of ['evaluate(x)', 'compiled = re.compile(r"x")', 'exec python3 run.py', 'exec\tnode x.js']) {
      expect(reShellsText(`python3 - <<'PY'\n${c}\nPY`)).toBe(true)
    }
  })

  it('the #2514 rows stay denied (a visible or hidden shell call with a glob)', () => {
    expect(run("python3 -c \"import os; os.system('echo x | tee @H@/.claude/set*')\"").deny).toBe(true)
    expect(run("python3 -c \"__import__('os').system('tee @H@/.claude/set*')\"").deny).toBe(true)
    expect(run("node -e \"require('child_' + 'process').execSync('tee @H@/.claude/set*')\"").deny).toBe(true)
    expect(run("python3 - <<'PY'\nimport re\nrx = re.compile(r'@H@/.claude/*')\nPY")).toEqual(FREE)
  })
})

// INSTRFILES1104 A, closing decision (Samu 69992/69997/70023, Dani 70000): python code is data only by a CLOSED
// allowlist (scripts/hooks/py-inline-data.py, the real ast under /usr/bin/python3 -I -S). Each rule part has its own
// row with the checker's reason, so taking one part out fails that row.
describe('1b. python code is data only by the closed allowlist', () => {
  const T = '@H@/.claude/settings.js*'
  it.each([
    // Dani's forms of every earlier round (probe2-9) and the glob forms of 69994/69997
    [`python3 -c "from os import system; system('tee ${T}')"`, 'import'],
    [`python3 -c "import os as o; o.system('tee ${T}')"`, 'import'],
    [`python3 -c "import operator; operator.attrgetter('ev'+'al')(print)"`, 'import'],
    [`python3 -c "import types; f = types.FunctionType"`, 'import'],
    [`python3 -c "exec.__call__('x')"`, 'dunder'],
    [`python3 -c "print.__self__.eval('x')"`, 'dunder'],
    [`python3 -c "import sys; sys._getframe().f_builtins['ev'+'al']('x')"`, 'frame'],
    [`python3 -c "import glob; [open(p, 'a') for p in glob.glob('${T}')]"`, 'globapi'],
    [`python3 -c "import pathlib; [p.touch() for p in pathlib.Path('@H@/.claude').glob('settings.js*')]"`, 'globapi'],
    // rule (5): the pattern / directory-walk API, even with every name otherwise allowed
    [`python3 -c "import json; json.loads(s).glob('${T}')"`, 'globapi'],
    // the routes of 70019 point 3: an allowed module's attribute that is a module, a private name, a frame
    [`python3 -c "import re; re.enum.bltns; print('${T}')"`, 'module-attr'],
    [`python3 -c "import json; json.codecs; print('${T}')"`, 'module-attr'],
    [`python3 -c "import statistics; statistics.sys; print('${T}')"`, 'module-attr'],
    [`python3 -c "import csv; csv.types.FunctionType; print('${T}')"`, 'module-attr'],
    [`python3 -c "import xml.etree.ElementTree as E; E.sys.modules; print('${T}')"`, 'module-attr'],
    [`python3 -c "import random; random._os; print('${T}')"`, 'private'],
    [`python3 -c "d = {}; d._x; print('${T}')"`, 'private'],
    [`python3 -c "from random import _os; print('${T}')"`, 'import'],
    [`python3 -c "g = (x for x in [0]); g.gi_frame; print('${T}')"`, 'frame'],
    [`python3 -c "s = 'gi_frame'; print('${T}')"`, 'frame-word'],
    // Samu 70023 (2): import *, an alias held bare, a module name rebound
    [`python3 -c "from json import *; print('${T}')"`, 'import-star'],
    [`python3 -c "import re as r; x = r; print('${T}')"`, 'bare-module'],
    [`python3 -c "from json import loads as l; import re; re = l; print('${T}')"`, 'module-rebound'],
    // builtins: never, a name not on the list, as a value too
    [`python3 -c "f = getattr; print('${T}')"`, 'never'],
    [`python3 -c "x.eval; print('${T}')"`, 'never'],
    [`python3 -c "t = type(1); print('${T}')"`, 'builtin'],
    [`python3 -c "help(); print('${T}')"`, 'never'],
    // dunder in text, format_map, .format on a non-literal
    [`python3 -c "s = '__class__'; print('${T}')"`, 'dunder'],
    [`python3 -c "'{0}'.format_map({}); print('${T}')"`, 'format_map'],
    [`python3 -c "f = '{}'; f.format(1); print('${T}')"`, 'format'],
    // Samu 70023 (1): code the ast cannot parse
    [`python3 -c "print('${T}'"`, 'unparsed'],
    // the code is not visible: a script, -m, code from a pipe, an expanding word, a substitution
    [`python3 /tmp/lg.py '${T}'`, 'script-or-module'],
    [`python3 -m json.tool '${T}'`, 'script-or-module'],
    [`python3 --version '${T}'`, 'option'],
    [`cat <<'EOF' | python3 -\nprint('${T}')\nEOF`, 'stdin'],
    [`python3 - < /tmp/lg.py '${T}'`, 'stdin'],
    [`X='import glob'; python3 -c "$X; print('${T}')"`, 'code-expands'],
    [`P=python3; $P -c "import glob" '${T}'`, 'program-expands'],
    [`P=python3; env "$P" -c "print(1)" '${T}'`, 'wrapper-expands'],
    [`python3 "$OPT" -c "print(1)" '${T}'`, 'option-expands'],
    [`echo "$(python3 -c 'import glob')" '${T}'`, 'substitution'],
    [`echo $(python3 -c 'import glob') '${T}'`, 'substitution'],
    // a later stdin redirect wins over the heredoc: the code comes from the file
    [`python3 - <<'PY' < /tmp/lg.py\nprint('${T}')\nPY`, 'stdin'],
    [`python3 - <<PY\nprint('\\$HOME', '${T}')\nPY`, 'heredoc-expands'],
    [`python3 - <<'PY'\nprint('${T}')`, 'heredoc-unterminated'],
    [`python3 -c 'print(1)' 'unterminated`, 'quote'],
    // Dani 70116: what Python reads is not always the text. Names are NFKC-normalized, so every name must be ASCII
    // (a full-width underscore is an underscore); a coding declaration or a BOM re-decodes the text.
    [`python3 -c "print(print._＿self＿_)" '${T}'`, 'non-ascii'],
    [`python3 - <<'PY'\nｐrint('${T}')\nPY`, 'non-ascii'],
    [`python3 -c "print('{x}'.format＿map({}))" '${T}'`, 'non-ascii'],
    [`python3 -c "x = 1; print(f'{x.＿＿class＿＿}')" '${T}'`, 'non-ascii'],
    [`python3 -c "print(f'á {1}')" '${T}'`, 'non-ascii'],
    [`python3 - <<'PY'\n# coding: utf-7\nprint('${T}')\nPY`, 'coding'],
    [`python3 - <<'PY'\n#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nprint('${T}')\nPY`, 'coding'],
    [`python3 -c "# vim: set fileencoding=utf-7 :\nprint(1)" '${T}'`, 'coding'],
    [`python3 - <<'PY'\n﻿print('${T}')\nPY`, 'coding'],
    [`python3 -c "print(int.__dict__)" '${T}'`, 'dunder'],
  ])('strict: %s -> %s', (c, why) => {
    const cmd = c.replaceAll('@H@', home)
    expect(pythonDataVerdict(cmd)).toBe(`strict ${why}`)
    expect(reShellsText(cmd)).toBe(true)
  })

  it.each([
    `python3 -c "print('${T}')"`,
    `python3 -c "import re; re.compile('x'); print('${T}')"`,
    `python3 -c "s = 'exec python3 run.py'; print('${T}')"`,
    `python3 -I -S -c "import json, sys; print(json.dumps(sys.argv[1:]))" '${T}'`,
    `python3 - <<'PY'\nimport re, json, sys\nd = json.load(sys.stdin)\nfor k in sorted(d):\n    print(re.sub(r'x$', '', k))\nPY`,
    `python3 - <<'PY'\ns = open('ChatView.kt').read()\nopen('ChatView.kt', 'w').write(s.replace('/** a */', '/** b */'))\nPY`,
    `python3 -c "import xml.etree.ElementTree as ET; print(ET.parse('a.xml').getroot().tag)"`,
    `python3 -c "from xml.etree import ElementTree as ET; print(ET.parse('a.xml'))"`,
    `python3 - <<'PY'\nfrom datetime import datetime\nimport hashlib\nif __name__ == '__main__':\n    try:\n        print(datetime.now(), hashlib.sha256(b'x').hexdigest())\n    except ValueError as e:\n        print(e)\nPY`,
    `python3 -c "print('{}'.format(1)); print('src/__tests__/x.ts')"`,
    `cd /tmp && python3 -c "import sys; print(sys.argv[1:])" a '*' 2>&1 | head -5`,
    // non-ASCII stays free in a plain string literal and in a comment; "coding" later than line 2 is a word
    `python3 -c "print('árvíztűrő tükörfúrógép', '${T}')"`,
    `python3 - <<'PY'\n# ékezetes megjegyzés\nimport json\nprint(json.dumps({'név': 'Béla'}, ensure_ascii=False), '${T}')\nPY`,
    `python3 - <<'PY'\nprint(1)\nprint(2)\n# coding: utf-8\nprint('${T}')\nPY`,
  ])('data: %s', (c) => {
    const cmd = c.replaceAll('@H@', home)
    expect(pythonDataVerdict(cmd)).toBe('data')
    expect(reShellsText(cmd)).toBe(false)
    expect(run(cmd)).toEqual(FREE)
  })

  it('the data rows above are denied when the glob reading is strict (the allowlist is what frees them)', () => {
    expect(run(`python3 -c "import glob; print('${T}')"`).deny).toBe(true)
    expect(run(`python3 -c "print('${T}')"`)).toEqual(FREE)
  })

  // Samu 70023 (3): no allowed attribute is a module, a frame, a code object (nor one level down), under every python
  // the test host has; a python update that breaks this fails here, the gate does not open
  it('the (module, attr) list reaches no module, frame or code object, under each python found', () => {
    let ran = 0
    for (const py of ['/usr/bin/python3', 'python3']) {
      const r = spawnSync(py, ['-I', '-S', join(process.cwd(), 'scripts', 'hooks', 'py-inline-data.py'), '--selftest'], { encoding: 'utf8' })
      if (r.error) continue
      ran++
      const out = JSON.parse(r.stdout)
      expect(out.bad, `python ${out.python}`).toEqual([])
    }
    expect(ran).toBeGreaterThan(0)
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
