// The egress parser reads a Python program that is run from a FILE (EGRESSPYFILE1113).
// Kept in a file of its own: bash-egress-parser.test.ts is appended to by every parser change.
import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { classify, setHookCwd, setScriptFileMode, scriptFileLogged, parseScriptFileMode, pythonScriptIndex } from '../../scripts/hooks/bash-egress-parser.mjs'

const HOOK = fileURLToPath(new URL('../../scripts/hooks/bash-egress-parser.mjs', import.meta.url))

// EGRESSPYFILE1113: a Python program run from a FILE was never read: the hook saw `python3 fetch.py`
// and nothing of the urllib call inside it (measured 2026-11-13: the run passed). The file named on
// the command line is now read and judged like a heredoc body.
describe('a Python script file named on the command line is read (EGRESSPYFILE1113)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bash-egress-pyfile-'))
  const FETCH = 'import urllib.request\nprint(urllib.request.urlopen("https://example.org/x").read())\n'
  const ARGV = 'import sys, urllib.request\nprint(urllib.request.urlopen(sys.argv[1]).read())\n'
  const LOCAL = 'import urllib.request\nprint(urllib.request.urlopen("http://localhost:3420/api/kanban").read())\n'
  const PLAIN = 'import json\n# docs: https://example.org/manual\nprint(json.dumps({"a": 1}))\n'
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'fetch.py'), FETCH)
  writeFileSync(join(dir, 'argv.py'), ARGV)
  writeFileSync(join(dir, 'local.py'), LOCAL)
  writeFileSync(join(dir, 'plain.py'), PLAIN)
  writeFileSync(join(dir, 'sub', 'fetch.py'), FETCH)
  beforeEach(() => { setHookCwd(dir); setScriptFileMode('on') })
  afterEach(() => { setHookCwd(undefined); setScriptFileMode('off') })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const verdict = (c: string, hosts: string[] = []) => classify(c, 0, new Set(hosts))

  it('denies a file whose code fetches an external URL, by relative and by absolute path', () => {
    for (const c of [
      'python3 fetch.py',
      'python3 -u fetch.py',
      'python3 -W ignore fetch.py',
      'python fetch.py > out.txt 2>&1',
      `python3 ${join(dir, 'fetch.py')}`,
      `python3 "${join(dir, 'fetch.py')}"`,
      'echo start && python3 fetch.py',
      'cd sub && python3 fetch.py',
      `cd ${dir} && python3 sub/fetch.py`,
      '(cd sub; python3 fetch.py)',
      'timeout 30 python3 fetch.py',
    ]) {
      const r = verdict(c)
      expect(r.deny, c).toBe(true)
      expect(r.reason, c).toBe('script-file-external')
      expect(r.hosts, c).toEqual(['example.org'])
    }
  })
  it('denies an external URL handed to a fetching script as an argument', () => {
    expect(verdict('python3 argv.py https://example.org/x').deny).toBe(true)
    expect(verdict('python3 argv.py http://localhost:3420/api/kanban').deny).toBe(false)
  })
  it('passes a listed vendor host, a localhost call, and a script that only mentions a URL', () => {
    expect(verdict('python3 fetch.py', ['example.org']).deny).toBe(false)
    expect(verdict('python3 argv.py https://example.org/x', ['example.org']).deny).toBe(false)
    expect(verdict('python3 local.py').deny).toBe(false)
    expect(verdict('python3 plain.py').deny).toBe(false)
    expect(verdict('python3 plain.py https://example.org/x').deny).toBe(false)
  })
  it('passes, as before, what it cannot read: a missing file, an undecidable path or directory, -m', () => {
    for (const c of [
      'python3 missing.py',
      'python3 "$S"',
      'cd "$D" && python3 fetch.py',
      'pushd sub && python3 fetch.py',
      'python3 -m http.server',
      'python3 sub',
    ]) expect(verdict(c).deny, c).toBe(false)
    setHookCwd(undefined)
    expect(verdict('python3 fetch.py').deny).toBe(false)
  })

  // --- review of #2736 ---
  it('is a setting: off by default it reads nothing, "log" records without blocking', () => {
    setScriptFileMode('off')
    expect(verdict('python3 fetch.py').deny).toBe(false)
    expect(scriptFileLogged()).toEqual([])
    setScriptFileMode('log')
    expect(verdict('python3 fetch.py').deny).toBe(false)
    expect(verdict('python3 local.py').deny).toBe(false)
    expect(scriptFileLogged()).toEqual([{ file: join(dir, 'fetch.py'), hosts: ['example.org'] }])
    // a listed vendor host is not recorded either
    setScriptFileMode('log')
    expect(verdict('python3 fetch.py', ['example.org']).deny).toBe(false)
    expect(scriptFileLogged()).toEqual([])
    expect(parseScriptFileMode({ script_files: 'on' })).toBe('on')
    expect(parseScriptFileMode({ script_files: 'log' })).toBe('log')
    for (const raw of [undefined, null, {}, { script_files: true }, { script_files: 'ON' }, { script_files: 'yes' }, []]) expect(parseScriptFileMode(raw)).toBe('off')
  })
  it('names the file in the verdict', () => {
    expect(verdict('python3 fetch.py').file).toBe(join(dir, 'fetch.py'))
    expect(verdict('cd sub && python3 fetch.py').file).toBe(join(dir, 'sub', 'fetch.py'))
  })
  it('reads the file behind an attached -W / -X value, and still leaves a -c / -m run alone', () => {
    for (const c of [
      'python3 -Wonce fetch.py',
      'python3 -Ximporttime fetch.py',
      'python3 -X importtime fetch.py',
      'python3 -uWignore fetch.py',
      'python3 -BW ignore fetch.py',
      'python3 -Wdefault::DeprecationWarning -u fetch.py',
      'python3 -- fetch.py',
    ]) expect(verdict(c).deny, c).toBe(true)
    expect(pythonScriptIndex(['-Wonce', 'f.py'])).toBe(1)
    expect(pythonScriptIndex(['-Ximporttime', 'f.py'])).toBe(1)
    expect(pythonScriptIndex(['-X', 'importtime', 'f.py'])).toBe(2)
    expect(pythonScriptIndex(['-uW', 'ignore', 'f.py', 'x'])).toBe(2)
    expect(pythonScriptIndex(['--check-hash-based-pycs', 'always', 'f.py'])).toBe(2)
    for (const a of [['-c', 'pass'], ['-m', 'http.server'], ['-uc', 'pass'], ['-Bm', 'json.tool'], ['-'], [], ['-u']]) expect(pythonScriptIndex(a), a.join(' ')).toBe(-1)
  })
  it('reads the file when a redirect is glued to its name', () => {
    for (const c of ['python3 fetch.py>out.txt', 'python3 fetch.py>>out.txt 2>&1', 'python3 fetch.py<in.txt', 'python3 -u fetch.py>out.txt']) {
      const r = verdict(c)
      expect(r.deny, c).toBe(true)
      expect(r.file, c).toBe(join(dir, 'fetch.py'))
    }
  })
  it('follows a quoted cd operand like an unquoted one', () => {
    for (const c of ['cd "sub" && python3 fetch.py', "cd 'sub' && python3 fetch.py", `cd "${dir}/sub"; python3 fetch.py`, 'cd "sub"&&python3 fetch.py']) {
      const r = verdict(c)
      expect(r.deny, c).toBe(true)
      expect(r.file, c).toBe(join(dir, 'sub', 'fetch.py'))
    }
  })
  it('follows cd: the same name in two directories is judged by the body the run will load', () => {
    const two = mkdtempSync(join(tmpdir(), 'bash-egress-pyfile-cd-'))
    try {
      mkdirSync(join(two, 'ext')); mkdirSync(join(two, 'loc')); mkdirSync(join(two, 'ext', 'deep'))
      writeFileSync(join(two, 'ext', 'job.py'), FETCH)
      writeFileSync(join(two, 'loc', 'job.py'), LOCAL)
      writeFileSync(join(two, 'ext', 'deep', 'job.py'), LOCAL)
      setHookCwd(two)
      expect(verdict('cd ext && python3 job.py').deny).toBe(true)
      expect(verdict('cd loc && python3 job.py').deny).toBe(false)
      expect(verdict('cd "ext" && python3 job.py').deny).toBe(true)
      expect(verdict('cd "loc" && python3 job.py').deny).toBe(false)
      // the LAST cd before the run decides, relative to the one before it
      expect(verdict('cd loc && cd ../ext && python3 job.py').deny).toBe(true)
      expect(verdict('cd ext && cd ../loc && python3 job.py').deny).toBe(false)
      expect(verdict('cd ext && cd deep && python3 job.py').deny).toBe(false)
      expect(verdict('cd ext && python3 job.py; cd ../loc').deny).toBe(true)
      // a cd AFTER the run does not move it
      expect(verdict('python3 loc/job.py && cd ext').deny).toBe(false)
      // no job.py in the hook's own directory: nothing to read, passes
      expect(verdict('python3 job.py').deny).toBe(false)
    } finally { rmSync(two, { recursive: true, force: true }) }
  })
  it('reads a file up to the size limit and passes a larger one unread', () => {
    const LIMIT = 1024 * 1024
    const pad = (n: number) => FETCH + '#'.repeat(n - FETCH.length - 1) + '\n'
    writeFileSync(join(dir, 'at-limit.py'), pad(LIMIT))
    writeFileSync(join(dir, 'over-limit.py'), pad(LIMIT + 1))
    expect(verdict('python3 at-limit.py').deny).toBe(true)
    expect(verdict('python3 over-limit.py').deny).toBe(false)
  })
  it('does not take a format placeholder for a host, nor a URL in a comment for a destination', () => {
    writeFileSync(join(dir, 'tmpl.py'), 'import urllib.request\nBASE = "https://%s/api"\nALT = "https://{host}/v1"\nurllib.request.urlopen(BASE % "localhost")\n')
    writeFileSync(join(dir, 'tmpl-real.py'), 'import urllib.request\nBASE = "https://%s/api"\nurllib.request.urlopen("https://example.org/x")\n')
    writeFileSync(join(dir, 'commented.py'), 'import urllib.request\n# upstream docs: https://example.org/manual\nurllib.request.urlopen("http://localhost:3420/api/kanban")  # was https://example.net/old\n')
    writeFileSync(join(dir, 'hash-in-string.py'), 'import urllib.request\nurllib.request.urlopen("https://example.org/page#top")\nNOTE = "# not a comment: https://example.net/x"\n')
    expect(verdict('python3 tmpl.py').deny).toBe(false)
    expect(verdict('python3 tmpl-real.py').hosts).toEqual(['example.org'])
    expect(verdict('python3 commented.py').deny).toBe(false)
    expect(verdict('python3 hash-in-string.py').hosts).toEqual(['example.org', 'example.net'])
  })
  it('entry point: the setting comes from the vendor-hosts file, the message names the file, "log" only records', () => {
    const run = (mode: string | null, log: string) => {
      const vendor = join(dir, `vendor-${mode}.json`)
      if (mode !== null) writeFileSync(vendor, JSON.stringify({ hosts: [], script_files: mode }))
      return spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ tool_name: 'Bash', cwd: dir, tool_input: { command: 'python3 fetch.py' } }),
        encoding: 'utf-8',
        env: { ...process.env, BASH_EGRESS_BLOCK_LOG: log, BASH_EGRESS_VENDOR_HOSTS: mode === null ? join(dir, 'no-such.json') : vendor },
      })
    }
    const offLog = join(dir, 'off.jsonl'), logLog = join(dir, 'log.jsonl'), onLog = join(dir, 'on.jsonl')
    for (const mode of [null, 'off']) {
      const r = run(mode, offLog)
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
    }
    expect(existsSync(offLog)).toBe(false)
    const logged = run('log', logLog)
    expect(logged.stdout).toBe('')
    const rec = JSON.parse(readFileSync(logLog, 'utf-8').trim())
    expect(rec).toMatchObject({ reason: 'script-file-external', mode: 'log-only', file: join(dir, 'fetch.py'), hosts: ['example.org'] })
    const denied = run('on', onLog)
    const out = JSON.parse(denied.stdout).hookSpecificOutput
    expect(out.permissionDecision).toBe('deny')
    expect(out.permissionDecisionReason).toContain(join(dir, 'fetch.py'))
    expect(out.permissionDecisionReason).toContain('szkriptfajl TARTALMA')
    expect(out.permissionDecisionReason).toContain('example.org')
    expect(JSON.parse(readFileSync(onLog, 'utf-8').trim())).toMatchObject({ reason: 'script-file-external', file: join(dir, 'fetch.py') })
  })
})
