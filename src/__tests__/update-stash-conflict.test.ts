import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync, chmodSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ANETTUPDATESTASH1102 (field report, 2026-11-02): a dashboard "stash + update"
// run whose `git stash pop` conflicted left conflict markers in the TRACKED
// .claude/settings.json, printed one warning line and restarted the services.
// Claude Code does not load an invalid settings.json, so the project-scope hooks
// (email approval, outgoing copy gate) silently stopped, and the run said success.
//
// These tests RUN the real update.sh text (the stash/settings block and the
// generated finalizer) against a REAL throwaway git repo -- the conflict is a
// real `git stash pop` conflict, not a stub.

const UPDATE = readFileSync(join(__dirname, '..', '..', 'update.sh'), 'utf-8')
const SANDBOX = mkdtempSync(join(tmpdir(), 'upd-stashconf-'))
afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

// From the first state variable through the settings gate: pop_auto_stash,
// restore_stash_before_exit, add_update_warn, settings_json_valid, settings_json_gate.
function stashBlock(): string {
  const start = UPDATE.indexOf('STASH_POP_FAILED=0\n')
  const end = UPDATE.indexOf('# UPDOOMNPMCI926: `npm ci` failed after the pull.')
  expect(start, 'stash block start not found').toBeGreaterThan(-1)
  expect(end, 'stash block end not found').toBeGreaterThan(start)
  return UPDATE.slice(start, end)
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
}

function sh(dir: string, script: string) {
  const r = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf-8', env: GIT_ENV })
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

function git(dir: string, args: string): string {
  return sh(dir, `git ${args}`).out
}

const SETTINGS = '.claude/settings.json'
const V1 = '{\n  "hooks": { "PreToolUse": [] },\n  "v": 1\n}\n'
const LOCAL = '{\n  "hooks": { "PreToolUse": [] },\n  "v": 2\n}\n'
const UPSTREAM = '{\n  "hooks": { "PreToolUse": [] },\n  "v": 3\n}\n'

// A repo with a committed settings.json, a locally edited settings.json and
// other.txt, auto-stashed exactly as update.sh does, and (optionally) an
// upstream commit that changes the same settings.json line.
function repo(opts: { conflict: boolean }): string {
  const dir = mkdtempSync(join(SANDBOX, 'repo-'))
  mkdirSync(join(dir, '.claude'))
  writeFileSync(join(dir, SETTINGS), V1)
  writeFileSync(join(dir, 'other.txt'), 'base\n')
  expect(sh(dir, 'git init -q && git add -A && git commit -qm base').code).toBe(0)
  writeFileSync(join(dir, SETTINGS), LOCAL)
  writeFileSync(join(dir, 'other.txt'), 'local\n')
  expect(sh(dir, 'git stash push -q -u -m "marveen-update-auto-stash 20261102-115215"').code).toBe(0)
  if (opts.conflict) {
    writeFileSync(join(dir, SETTINGS), UPSTREAM)
    expect(sh(dir, 'git commit -qam upstream').code).toBe(0)
  }
  return dir
}

function runBlock(dir: string, tail: string) {
  const script = [
    "RED=''; NC=''",
    'RESULT_STATUS=success; RESULT_MSG=""',
    stashBlock(),
    'STASHED_AUTO=1',
    tail,
    'printf "%s" "$UPDATE_WARN" > .warn',
    'printf "%s" "$RESULT_STATUS" > .status',
    'printf "%s" "$STASHED_AUTO" > .stashed',
  ].join('\n')
  const r = sh(dir, script)
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf-8') : '')
  return { ...r, warn: read('.warn'), status: read('.status'), stashed: read('.stashed') }
}

const isJson = (s: string) => { try { JSON.parse(s); return true } catch { return false } }

describe('update.sh: a conflicted auto-stash pop (ANETTUPDATESTASH1102)', () => {
  it('puts the conflicted settings.json back to the upstream version, valid JSON, no markers', () => {
    const dir = repo({ conflict: true })
    const r = runBlock(dir, 'pop_auto_stash; echo "rc=$?"')
    expect(r.out).toContain('rc=1')
    const now = readFileSync(join(dir, SETTINGS), 'utf-8')
    expect(now).toBe(UPSTREAM)
    expect(now).not.toContain('<<<<<<<')
    expect(isJson(now)).toBe(true)
  })

  it('leaves no unmerged path and nothing staged, and keeps the cleanly restored local edit', () => {
    const dir = repo({ conflict: true })
    runBlock(dir, 'pop_auto_stash')
    expect(git(dir, 'diff --name-only --diff-filter=U').trim()).toBe('')
    expect(git(dir, 'diff --cached --name-only').trim()).toBe('')
    expect(readFileSync(join(dir, 'other.txt'), 'utf-8')).toBe('local\n')
  })

  it('keeps the stash entry (the operator\'s only copy) and names the path in the warning', () => {
    const dir = repo({ conflict: true })
    const r = runBlock(dir, 'pop_auto_stash')
    expect(git(dir, 'stash list')).toContain('marveen-update-auto-stash 20261102-115215')
    expect(git(dir, 'show stash@{0}:.claude/settings.json')).toBe(LOCAL)
    expect(r.warn).toContain('.claude/settings.json')
    expect(r.warn).toContain('git stash list')
    expect(r.stashed).toBe('0')
  })

  it('the conflict report says per path what came back and what is only in the stash', () => {
    const dir = repo({ conflict: true })
    const r = runBlock(dir, 'pop_auto_stash')
    expect(r.warn).toMatch(/Visszakerult: [^.]*other\.txt/)
    expect(r.warn).toMatch(/NEM kerult vissza, csak a stash-ben van: [^.]*\.claude\/settings\.json/)
  })

  // Dani (2460 review, git 2.50.1): with an untracked stash file in the way git
  // refuses the pop ("already exists, no checkout") but STILL restores the
  // tracked edits. The report must not claim that nothing came back.
  it('a pop refused by an untracked file in the way reports the tracked edit as restored', () => {
    const dir = mkdtempSync(join(SANDBOX, 'refused-'))
    writeFileSync(join(dir, 'keep.txt'), 'base\n')
    expect(sh(dir, 'git init -q && git add -A && git commit -qm base').code).toBe(0)
    writeFileSync(join(dir, 'keep.txt'), 'local\n')
    writeFileSync(join(dir, 'new.txt'), 'local new\n')
    expect(sh(dir, 'git stash push -q -u -m "marveen-update-auto-stash 20261102-115215"').code).toBe(0)
    writeFileSync(join(dir, 'new.txt'), 'upstream new\n')
    expect(sh(dir, 'git add new.txt && git commit -qm upstream').code).toBe(0)
    const r = runBlock(dir, 'pop_auto_stash; echo "rc=$?"')
    expect(r.out).toContain('rc=1')
    expect(readFileSync(join(dir, 'keep.txt'), 'utf-8')).toBe('local\n')
    expect(readFileSync(join(dir, 'new.txt'), 'utf-8')).toBe('upstream new\n')
    expect(git(dir, 'stash list')).toContain('marveen-update-auto-stash')
    expect(r.warn).toMatch(/Visszakerult: [^.]*keep\.txt/)
    expect(r.warn).toMatch(/NEM kerult vissza, csak a stash-ben van: [^.]*new\.txt/)
    expect(r.warn).not.toContain('nem lehetett visszatenni')
  })

  it('a clean pop restores everything, drops the stash, and warns about nothing', () => {
    const dir = repo({ conflict: false })
    const r = runBlock(dir, 'pop_auto_stash; echo "rc=$?"')
    expect(r.out).toContain('rc=0')
    expect(r.warn).toBe('')
    expect(readFileSync(join(dir, SETTINGS), 'utf-8')).toBe(LOCAL)
    expect(git(dir, 'stash list').trim()).toBe('')
  })

  it('on an early clean exit the "success" verdict becomes "warning" when the pop conflicts', () => {
    const dir = repo({ conflict: true })
    const r = runBlock(dir, 'restore_stash_before_exit')
    expect(r.status).toBe('warning')
  })

  it('a clean early-exit pop leaves the verdict alone', () => {
    const dir = repo({ conflict: false })
    const r = runBlock(dir, 'restore_stash_before_exit')
    expect(r.status).toBe('success')
  })
})

describe('update.sh: the settings.json gate before the restart (ANETTUPDATESTASH1102)', () => {
  function committed(content: string): string {
    const dir = mkdtempSync(join(SANDBOX, 'gate-'))
    mkdirSync(join(dir, '.claude'))
    writeFileSync(join(dir, SETTINGS), content)
    expect(sh(dir, 'git init -q && git add -A && git commit -qm base').code).toBe(0)
    return dir
  }

  it('an invalid working copy is saved under store/ and the valid HEAD version restored', () => {
    const dir = committed(V1)
    const broken = '{\n<<<<<<< Updated upstream\n  "v": 3\n=======\n  "v": 2\n>>>>>>> Stashed changes\n}\n'
    writeFileSync(join(dir, SETTINGS), broken)
    const r = runBlock(dir, 'settings_json_gate')
    expect(readFileSync(join(dir, SETTINGS), 'utf-8')).toBe(V1)
    const saved = readdirSync(join(dir, 'store')).filter(f => f.startsWith('settings.json.invalid-'))
    expect(saved.length).toBe(1)
    expect(readFileSync(join(dir, 'store', saved[0]), 'utf-8')).toBe(broken)
    expect(r.warn).toContain('ervenytelen')
  })

  it('a valid settings.json passes untouched and adds no warning', () => {
    const dir = committed(V1)
    const r = runBlock(dir, 'settings_json_gate')
    expect(r.warn).toBe('')
    expect(existsSync(join(dir, 'store'))).toBe(false)
  })

  it('when even HEAD is invalid it says so loudly instead of claiming a repair', () => {
    const dir = committed('{ not json\n')
    const r = runBlock(dir, 'settings_json_gate')
    expect(r.warn).toContain('nem sikerult visszaallitani')
  })

  it('an invalid agent settings.json is reported by path, not rewritten', () => {
    const dir = committed(V1)
    mkdirSync(join(dir, 'agents', 'bob', '.claude'), { recursive: true })
    writeFileSync(join(dir, 'agents', 'bob', '.claude', 'settings.json'), '{ bad')
    const r = runBlock(dir, 'settings_json_gate')
    expect(r.warn).toContain('agents/bob/.claude/settings.json')
    expect(readFileSync(join(dir, 'agents', 'bob', '.claude', 'settings.json'), 'utf-8')).toBe('{ bad')
  })

  it('the gate runs on the main path after the final pop, before the finalizer is launched', () => {
    const pop = UPDATE.indexOf('  echo -e "  Auto-stash visszaallitasa..."')
    const gate = UPDATE.indexOf('\nsettings_json_gate\n')
    const launch = UPDATE.indexOf('FINALIZE_LAUNCHED=1\n')
    expect(pop).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(pop)
    expect(launch).toBeGreaterThan(gate)
    expect(UPDATE).toMatch(/FINALIZE_ARGS=\([^)]*"\$UPDATE_WARN"\)/)
  })
})

describe('update.sh finalizer: a warning is never reported as success (ANETTUPDATESTASH1102)', () => {
  function finalizer(): string {
    const i = UPDATE.indexOf("cat > \"$FINALIZE_SCRIPT\" <<'FINALIZE_EOF'")
    const j = UPDATE.indexOf('\nFINALIZE_EOF\n', i)
    expect(i).toBeGreaterThan(-1)
    return UPDATE.slice(i, j).split('\n').slice(1).join('\n') + '\n'
  }

  function runFinalizer(warn: string) {
    const dir = mkdtempSync(join(SANDBOX, 'fin-'))
    for (const d of ['store', 'scripts', 'bin']) mkdirSync(join(dir, d))
    writeFileSync(join(dir, 'finalize.sh'), finalizer())
    const exe = (p: string, body: string) => { writeFileSync(join(dir, p), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(dir, p), 0o755) }
    exe('scripts/stop.sh', 'exit 0')
    exe('scripts/start.sh', 'exit 0')
    exe('scripts/notify.sh', `printf '%s' "$1" > '${dir}/notified'`)
    exe('bin/curl', 'exit 0')
    exe('bin/pidof', 'exit 1')
    const r = spawnSync('bash', [join(dir, 'finalize.sh'), dir, '', 'old1234', '3420', join(dir, 'store', 'res.json'), join(dir, 'store', 'built'), 'new5678', '', '1', warn],
      { cwd: dir, encoding: 'utf-8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` } })
    const res = JSON.parse(readFileSync(join(dir, 'store', 'res.json'), 'utf-8'))
    const notified = existsSync(join(dir, 'notified')) ? readFileSync(join(dir, 'notified'), 'utf-8') : ''
    return { code: r.status, res, notified }
  }

  it('with a warning, a healthy restart writes "warning" with the message and says it on the channel', () => {
    const r = runFinalizer('A .claude/settings.json ervenytelen JSON volt.')
    expect(r.code).toBe(0)
    expect(r.res.status).toBe('warning')
    expect(r.res.message).toContain('settings.json')
    expect(r.notified).toContain('kézi figyelem')
    expect(r.notified).toContain('settings.json')
  })

  it('without a warning, it is still a plain success', () => {
    const r = runFinalizer('')
    expect(r.res.status).toBe('success')
  })
})
