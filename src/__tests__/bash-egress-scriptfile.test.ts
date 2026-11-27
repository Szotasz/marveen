// The egress parser reads a node / deno / bun or shell script FILE, and a downloader a Python or JS file
// starts as a child program (EGRESSZKRIPTFAJL1127). Python file reading itself: bash-egress-pyfile.test.ts.
import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { classify, setHookCwd, setScriptFileMode, scriptFileLogged, jsScriptIndex, shellScriptIndex } from '../../scripts/hooks/bash-egress-parser.mjs'

// Measured 2026-11-27 on develop 9c49895a1 (external report, v1.53.0): with "script_files": "on" a Python
// file that runs `subprocess.run(["curl", URL])`, a node file with fetch(), and a bash file with a curl
// line all PASSED; only a Python file with urllib was denied.
describe('script files beyond the Python network primitives are read (EGRESSZKRIPTFAJL1127)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bash-egress-scriptfile-'))
  const files: Record<string, string> = {
    'py_sub.py': 'import subprocess\nsubprocess.run(["curl", "-s", "https://example.org/a"])\n',
    'py_sys.py': 'import os\nos.system("wget -q https://example.org/a")\n',
    'py_sub_local.py': 'import subprocess\nsubprocess.run(["curl", "-s", "http://localhost:3420/api/kanban"])\n',
    'py_sub_comment.py': 'import subprocess\n# like: curl https://example.org/a\nsubprocess.run(["ls"])\n',
    'js_fetch.mjs': "await fetch('https://example.org/a')\n",
    'js_child.js': "const { execSync } = require('child_process')\nexecSync('curl -s https://example.org/a')\n",
    'js_local.mjs': "await fetch('http://localhost:3420/api/kanban')\n",
    'js_plain.mjs': "console.log('docs: https://example.org/manual')\n",
    'ts_fetch.ts': "await fetch('https://example.org/a')\n",
    'sh_curl.sh': 'set -e\ncurl -s https://example.org/a\n',
    'sh_local.sh': 'curl -s http://localhost:3420/api/kanban\n',
    'sh_nested.sh': 'bash sh_curl.sh\n',
    'sh_self.sh': 'bash sh_self.sh\n',
    'sh_arg.sh': 'curl -s "$1"\n',
  }
  for (const [n, body] of Object.entries(files)) writeFileSync(join(dir, n), body)
  beforeEach(() => { setHookCwd(dir); setScriptFileMode('on') })
  afterEach(() => { setHookCwd(undefined); setScriptFileMode('off') })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const verdict = (c: string, hosts: string[] = []) => classify(c, 0, new Set(hosts))

  it('denies a Python file that starts curl / wget toward an external URL (the reported shape)', () => {
    for (const c of ['python3 py_sub.py', 'python3 py_sys.py', `python3 ${join(dir, 'py_sub.py')}`]) {
      const r = verdict(c)
      expect(r.deny, c).toBe(true)
      expect(r.reason, c).toBe('script-file-external')
      expect(r.hosts, c).toEqual(['example.org'])
    }
  })
  it('passes a Python file whose child curl goes to localhost, or that names curl only in a comment', () => {
    expect(verdict('python3 py_sub_local.py').deny).toBe(false)
    expect(verdict('python3 py_sub_comment.py').deny).toBe(false)
    expect(verdict('python3 py_sub.py', ['example.org']).deny).toBe(false)
  })
  it('denies a node / deno / bun file that fetches or starts curl toward an external URL', () => {
    for (const c of ['node js_fetch.mjs', 'node --no-warnings js_fetch.mjs', 'node -r dotenv/config js_child.js',
      'deno run --allow-net ts_fetch.ts', 'deno ts_fetch.ts', 'bun run js_fetch.mjs', 'bun ts_fetch.ts', 'cd . && node js_child.js']) {
      const r = verdict(c)
      expect(r.deny, c).toBe(true)
      expect(r.reason, c).toBe('script-file-external')
      expect(r.hosts, c).toEqual(['example.org'])
    }
  })
  it('passes a JS file to localhost, one that only mentions a URL, a listed vendor host, and non-run subcommands', () => {
    expect(verdict('node js_local.mjs').deny).toBe(false)
    expect(verdict('node js_plain.mjs').deny).toBe(false)
    expect(verdict('node js_fetch.mjs', ['example.org']).deny).toBe(false)
    expect(verdict('deno fmt ts_fetch.ts').deny).toBe(false)
    expect(verdict('bun install').deny).toBe(false)
  })
  it('judges a shell script file like the command itself, nested files included', () => {
    const r = verdict('bash sh_curl.sh')
    expect(r.deny).toBe(true)
    expect(r.reason).toMatch(/^script-file-shell-curl/)
    expect(r.hosts).toEqual(['example.org'])
    expect(verdict('sh -e sh_curl.sh').deny).toBe(true)
    expect(verdict('bash sh_nested.sh').deny).toBe(true)
    expect(verdict('bash sh_arg.sh https://example.org/a').deny).toBe(true)
    expect(verdict('bash sh_arg.sh http://localhost:3420/x').deny).toBe(false)
    expect(verdict('bash sh_local.sh').deny).toBe(false)
    expect(verdict('bash -n sh_curl.sh').deny).toBe(false)
  })
  it('a script that runs itself stops at the nesting limit, closed', () => {
    const r = verdict('bash sh_self.sh')
    expect(r.deny).toBe(true)
    expect(r.reason).toBe('script-file-shell-nesting-limit')
  })
  it('stays a setting: off reads nothing, "log" records without blocking', () => {
    setScriptFileMode('off')
    for (const c of ['python3 py_sub.py', 'node js_fetch.mjs', 'bash sh_curl.sh']) expect(verdict(c).deny, c).toBe(false)
    setScriptFileMode('log')
    for (const c of ['python3 py_sub.py', 'node js_fetch.mjs', 'bash sh_curl.sh']) expect(verdict(c).deny, c).toBe(false)
    expect(scriptFileLogged().map((f: { file: string }) => f.file.split('/').pop()).sort()).toEqual(['js_fetch.mjs', 'py_sub.py', 'sh_curl.sh'])
  })
  it('finds the program file among the runtime options', () => {
    expect(jsScriptIndex('node', ['-e', 'x'])).toBe(-1)
    expect(jsScriptIndex('node', ['--eval=x'])).toBe(-1)
    expect(jsScriptIndex('node', ['-p', 'x'])).toBe(-1)
    expect(jsScriptIndex('node', ['--import', 'tsx', 'f.ts', 'a'])).toBe(2)
    expect(jsScriptIndex('deno', ['run', '-A', 'f.ts'])).toBe(2)
    expect(jsScriptIndex('deno', ['test', 'f.ts'])).toBe(-1)
    expect(jsScriptIndex('bun', ['f.ts'])).toBe(0)
    expect(shellScriptIndex(['-c', 'x'])).toBe(-1)
    expect(shellScriptIndex(['-s'])).toBe(-1)
    expect(shellScriptIndex(['-n', 'f.sh'])).toBe(-1)
    expect(shellScriptIndex(['-o', 'pipefail', 'f.sh'])).toBe(2)
    expect(shellScriptIndex(['--', 'f.sh'])).toBe(1)
    expect(shellScriptIndex(['-ex', 'f.sh'])).toBe(1)
  })
})
