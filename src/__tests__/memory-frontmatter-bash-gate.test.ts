import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// KAPUEGYUT918: the Write/Edit gate (memory-frontmatter-gate.py) never sees a
// memory file written from Bash, and measured 2026-09-29 all 8 recall-blind
// files in the fleet store were written that way. The Bash after-gate takes a
// stat snapshot of the caller's own memory directories in PreToolUse(Bash) and,
// in PostToolUse(Bash) AND PostToolUseFailure(Bash), checks the files that
// changed and that the command names. Exit 2 does not undo the write (the
// command already ran); it hands the model the reason and the fix. What these
// tests pin: both after-events judge; only changed, named, caller-owned files
// are blamed; the hook's own errors never block (fail-open, one log line); the
// memory dir is found from the git root of the cwd (a sub-agent's memory lives
// under the repo root's slug) and counted once through a symlinked projects dir.

const ROOT = join(__dirname, '..', '..')
const HOOK = join(ROOT, 'scripts', 'hooks', 'memory-frontmatter-bash-gate.py')
const enc = (p: string) => p.replace(/[^A-Za-z0-9-]/g, '-')

const GOOD = '---\nname: reference_x\ndescription: "Mert allitas: ket dolog"\nmetadata:\n  type: reference\n---\n\nbody\n'
const BROKEN = '---\nname: reference_x\ndescription: Ket route-meresi csapda: a literal grep vak\nmetadata:\n  type: reference\n---\n\nbody\n'

let S: string, CONFIG: string, REPO: string, CWD: string, MEM: string, STATE: string, ERRLOG: string, TRANSCRIPT: string

beforeEach(() => {
  S = mkdtempSync(join(tmpdir(), 'memfm-bash-'))
  CONFIG = join(S, 'cfg')
  REPO = join(S, 'repo')
  mkdirSync(join(REPO, '.git'), { recursive: true })
  CWD = join(REPO, 'agents', 'geri')
  mkdirSync(CWD, { recursive: true })
  // The memory lives under the REPO ROOT's slug; the transcript under the cwd's.
  MEM = join(CONFIG, 'projects', enc(REPO), 'memory')
  mkdirSync(MEM, { recursive: true })
  const tdir = join(CONFIG, 'projects', enc(CWD))
  mkdirSync(tdir, { recursive: true })
  TRANSCRIPT = join(tdir, 'sess.jsonl')
  STATE = join(S, 'state')
  ERRLOG = join(S, 'hook-errors.log')
  writeFileSync(join(MEM, 'reference_old.md'), GOOD)
})

function run(event: string, command: string, id = 'toolu_1', extra: Record<string, unknown> = {}, config = CONFIG): { code: number; stderr: string } {
  const payload = { hook_event_name: event, tool_name: 'Bash', tool_use_id: id, tool_input: { command }, cwd: CWD, transcript_path: TRANSCRIPT, ...extra }
  try {
    execFileSync('python3', [HOOK], {
      input: JSON.stringify(payload), timeout: 15_000, stdio: ['pipe', 'ignore', 'pipe'],
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, MEMFM_BASH_STATE_DIR: STATE, HOOK_ERRLOG_PATH: ERRLOG },
    })
    return { code: 0, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer }
    return { code: typeof e.status === 'number' ? e.status : -1, stderr: e.stderr?.toString() ?? '' }
  }
}

/** One Bash call: the pre snapshot, the "command" (a file write done here), and the after-event. */
function call(command: string, write: () => void, after = 'PostToolUse', id = 'toolu_1') {
  expect(run('PreToolUse', command, id).code).toBe(0)
  write()
  return run(after, command, id)
}

const errlog = () => (existsSync(ERRLOG) ? readFileSync(ERRLOG, 'utf8') : '')

describe('memory-frontmatter-bash-gate: a broken memory file written from Bash is caught after the call', () => {
  it('PostToolUse: a python-style write of a named file with a broken frontmatter -> exit 2, the file and the fix on stderr', () => {
    const r = call(`python3 - <<'EOF'\nopen('${MEM}/feedback_new.md','w').write(...)\nEOF`, () => writeFileSync(join(MEM, 'feedback_new.md'), BROKEN))
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('feedback_new.md')
    expect(r.stderr).toContain('LEFUTOTT')
    expect(r.stderr).toContain('JSON-stilusu dupla idezojelbe')
  })

  it('PostToolUseFailure: a failing command that still wrote the file is judged the same way', () => {
    const r = call(`cat > ${MEM}/feedback_new.md <<'EOF' ... EOF; exit 3`, () => writeFileSync(join(MEM, 'feedback_new.md'), BROKEN), 'PostToolUseFailure')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('feedback_new.md')
  })

  it('the name without .md in the command is enough (a script building the path)', () => {
    const r = call(`python3 -c "n='feedback_new'; open(M+n+'.md','w')"`, () => writeFileSync(join(MEM, 'feedback_new.md'), BROKEN))
    expect(r.code).toBe(2)
  })

  it('an edit (sed -i) that breaks an existing file is caught too', () => {
    const r = call(`sed -i '' 's/x/y/' ${MEM}/reference_old.md`, () => writeFileSync(join(MEM, 'reference_old.md'), BROKEN))
    expect(r.code).toBe(2)
  })
})

describe('memory-frontmatter-bash-gate: positive control and scope', () => {
  it('a valid write passes', () => {
    expect(call(`tee ${MEM}/feedback_new.md`, () => writeFileSync(join(MEM, 'feedback_new.md'), GOOD)).code).toBe(0)
  })

  it('a broken file the command does NOT name passes (a parallel writer is not blamed on the caller), with one log line', () => {
    const r = call('npm test', () => writeFileSync(join(MEM, 'feedback_other_agent.md'), BROKEN))
    expect(r.code).toBe(0)
    expect(errlog()).toContain('feedback_other_agent.md')
  })

  it('a broken file that was already there and did not change passes (only changes are judged)', () => {
    writeFileSync(join(MEM, 'feedback_legacy.md'), BROKEN)
    expect(call(`cat ${MEM}/feedback_legacy.md`, () => undefined).code).toBe(0)
  })

  it('MEMORY.md passes', () => {
    expect(call(`echo x >> ${MEM}/MEMORY.md`, () => writeFileSync(join(MEM, 'MEMORY.md'), 'no frontmatter')).code).toBe(0)
  })

  it('a memory dir of another project (not the caller\'s) passes', () => {
    const other = join(CONFIG, 'projects', '-Users-someone-else', 'memory')
    mkdirSync(other, { recursive: true })
    expect(call(`cat > ${other}/feedback_new.md`, () => writeFileSync(join(other, 'feedback_new.md'), BROKEN)).code).toBe(0)
  })

  it('a non-Bash tool and an unknown event pass', () => {
    expect(run('PostToolUse', 'x', 'toolu_9', { tool_name: 'Write' }).code).toBe(0)
    expect(run('SessionStart', 'x').code).toBe(0)
  })

  it('the snapshot is consumed by the after-event (no state left behind)', () => {
    call(`tee ${MEM}/feedback_new.md`, () => writeFileSync(join(MEM, 'feedback_new.md'), GOOD))
    expect(existsSync(STATE) ? readdirSync(STATE) : []).toEqual([])
  })
})

describe('memory-frontmatter-bash-gate: the caller\'s memory dir', () => {
  it('found from the git root of the cwd; a worktree (.git file) resolves to the main repo root', () => {
    const wt = join(S, 'wt')
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${REPO}/.git/worktrees/wt\n`)
    const payload = { transcript_path: join(S, 'nowhere', 'x.jsonl'), cwd: wt }
    expect(run('PreToolUse', `cat > ${MEM}/feedback_new.md`, 'toolu_wt', payload).code).toBe(0)
    writeFileSync(join(MEM, 'feedback_new.md'), BROKEN)
    expect(run('PostToolUse', `cat > ${MEM}/feedback_new.md`, 'toolu_wt', payload).code).toBe(2)
  })

  it('a symlinked projects dir is counted once (realpath), and still judged', () => {
    const cfg2 = join(S, 'cfg2')
    mkdirSync(cfg2)
    symlinkSync(join(CONFIG, 'projects'), join(cfg2, 'projects'))
    // Two spellings of ONE directory: the transcript's through the real config,
    // the git root's through the symlinked one.
    const extra = { transcript_path: join(CONFIG, 'projects', enc(REPO), 'sess.jsonl') }
    expect(run('PreToolUse', `cat > ${MEM}/feedback_new.md`, 'toolu_ln', extra, cfg2).code).toBe(0)
    const state = JSON.parse(readFileSync(join(STATE, 'toolu_ln.json'), 'utf8'))
    expect(state.dirs).toHaveLength(1)
    writeFileSync(join(MEM, 'feedback_new.md'), BROKEN)
    expect(run('PostToolUse', `cat > ${MEM}/feedback_new.md`, 'toolu_ln', extra, cfg2).code).toBe(2)
  })
})

describe('memory-frontmatter-bash-gate: the hook\'s own errors never block the call (fail-open, one log line)', () => {
  it('malformed stdin -> 0', () => {
    try {
      execFileSync('python3', [HOOK], { input: 'not json', timeout: 15_000, stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, HOOK_ERRLOG_PATH: ERRLOG } })
    } catch {
      throw new Error('exited non-zero on malformed stdin')
    }
    expect(errlog()).toContain('olvashatatlan stdin')
  })

  it('a corrupt snapshot -> 0 and a log line', () => {
    mkdirSync(STATE, { recursive: true })
    writeFileSync(join(STATE, 'toolu_bad.json'), '{not json')
    expect(run('PostToolUse', `cat > ${MEM}/feedback_new.md`, 'toolu_bad').code).toBe(0)
    expect(errlog()).toContain('belso hiba')
  })

  it('no snapshot for this call -> 0; no memory dir at all -> 0', () => {
    expect(run('PostToolUse', 'x', 'toolu_none').code).toBe(0)
    rmSync(MEM, { recursive: true, force: true })
    expect(run('PreToolUse', 'x', 'toolu_nomem').code).toBe(0)
    expect(run('PostToolUse', 'x', 'toolu_nomem').code).toBe(0)
  })
})

// HOOKDEPLOAD1008: the shared check used to be imported at module load, so a
// broken memory_frontmatter_lib.py made the hook exit 1 on every Bash call,
// the code it promises never to return. On a disposable copy (the intact copy
// shown first to judge like the real hook), a lib that does not load is the
// hook's own error: exit 0, the reason on stderr and one log line per event.
describe('memory-frontmatter-bash-gate: a memory_frontmatter_lib.py that does not load (HOOKDEPLOAD1008)', () => {
  const copyHook = (name: string, broken: boolean) => {
    const dir = join(S, 'hook-copy', name)
    mkdirSync(dir, { recursive: true })
    for (const f of ['memory-frontmatter-bash-gate.py', 'memory_frontmatter_lib.py', 'hook_errlog.py']) {
      copyFileSync(join(ROOT, 'scripts', 'hooks', f), join(dir, f))
    }
    if (broken) appendFileSync(join(dir, 'memory_frontmatter_lib.py'), '<'.repeat(7) + ' Updated upstream\n')
    return join(dir, 'memory-frontmatter-bash-gate.py')
  }
  // spawnSync, not run(): stderr is needed on exit 0 too.
  const spawn = (hook: string, event: string, command: string, id: string, extra: Record<string, unknown> = {}) => {
    const payload = { hook_event_name: event, tool_name: 'Bash', tool_use_id: id, tool_input: { command }, cwd: CWD, transcript_path: TRANSCRIPT, ...extra }
    const r = spawnSync('python3', [hook], {
      input: JSON.stringify(payload), encoding: 'utf-8', timeout: 15_000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG, MEMFM_BASH_STATE_DIR: STATE, HOOK_ERRLOG_PATH: ERRLOG },
    })
    return { code: r.status, stderr: r.stderr }
  }
  const brokenWrite = (hook: string, id: string) => {
    const cmd = `cat > ${MEM}/feedback_new.md`
    writeFileSync(join(MEM, 'feedback_new.md'), GOOD)
    const pre = spawn(hook, 'PreToolUse', cmd, id)
    writeFileSync(join(MEM, 'feedback_new.md'), BROKEN)
    return { pre, post: spawn(hook, 'PostToolUse', cmd, id) }
  }

  it('control: the intact copy judges a broken named write like the real hook (exit 2)', () => {
    const real = brokenWrite(join(ROOT, 'scripts', 'hooks', 'memory-frontmatter-bash-gate.py'), 'toolu_real')
    const copy = brokenWrite(copyHook('intact', false), 'toolu_copy')
    expect(copy).toEqual(real)
    expect(copy.post.code).toBe(2)
  })

  it('a lib that does not load -> exit 0 on both events (never 1), the lib named on stderr and in the log', () => {
    const { pre, post } = brokenWrite(copyHook('broken', true), 'toolu_broken')
    for (const r of [pre, post]) {
      expect(r.code).toBe(0)
      expect(r.stderr).toContain('scripts/hooks/memory_frontmatter_lib.py')
      expect(r.stderr).toContain('nem toltheto be')
    }
    expect(errlog().match(/memory_frontmatter_lib\.py\) nem toltheto be/g)).toHaveLength(2)
  })

  it('a non-Bash tool stays silent', () => {
    const r = spawn(copyHook('broken2', true), 'PostToolUse', 'x', 'toolu_w', { tool_name: 'Write' })
    expect(r).toEqual({ code: 0, stderr: '' })
    expect(errlog()).toBe('')
  })
})
