// The egress parser reads a Python program that is run from a FILE (EGRESSPYFILE1113).
// Kept in a file of its own: bash-egress-parser.test.ts is appended to by every parser change.
import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { classify, setHookCwd } from '../../scripts/hooks/bash-egress-parser.mjs'

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
  beforeEach(() => setHookCwd(dir))
  afterEach(() => setHookCwd(undefined))
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
})
