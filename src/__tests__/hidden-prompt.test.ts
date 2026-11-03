import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// A hidden password prompt can only be judged on a REAL terminal: readline
// echoes and redraws differently when the streams are not TTYs, so a pipe-based
// test passes against the broken version too (card b4bf49ec: the prompt text was
// wiped by a line-refresh sequence and the typed password showed in clear, which
// the first version of this fix would have shipped had it been checked on a pipe).
// The child therefore runs under a python pty and the test reads exactly the
// bytes a user's terminal would receive.

const ROOT = join(__dirname, '..', '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const CHILD = join(__dirname, 'fixtures', 'hidden-prompt-child.ts')
const PYTHON = spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf-8' }).status === 0

const DRIVER = `
import os, pty, select, sys, time, json
tsx, child, pw = sys.argv[1], sys.argv[2], sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.execv(tsx, [tsx, child])
buf = b''
def pump(t):
    global buf
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try: d = os.read(fd, 4096)
            except OSError: return False
            if not d: return False
            buf += d
    return True
def wait_for(s, t=30):
    end = time.time() + t
    while time.time() < end and s not in buf:
        if not pump(0.2): break
    return s in buf
seen1 = wait_for(b'New password: ')
for ch in pw: os.write(fd, ch.encode()); pump(0.03)
os.write(fd, b'\\r')
seen2 = wait_for(b'Repeat password: ')
for ch in pw: os.write(fd, ch.encode()); pump(0.03)
os.write(fd, b'\\r')
wait_for(b'GOT:')
pump(0.5)
try: os.kill(pid, 9)
except Exception: pass
print(json.dumps({'seen1': seen1, 'seen2': seen2, 'out': buf.decode('utf-8', 'replace')}))
`

// Node 26 deprecates module.register(), which tsx (4.21) still calls: the DEP0205
// warning goes to the same terminal and landed right after "New password: ", so
// the test read it as prompt output and failed on a Node 26 host. Only that one
// warning is silenced for the child; any other warning still reaches the pty.
const CHILD_ENV = {
  ...process.env,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=DEP0205'].filter(Boolean).join(' '),
}

function runOnPty(password: string): { seen1: boolean; seen2: boolean; out: string } {
  const r = spawnSync('python3', ['-c', DRIVER, TSX, CHILD, password], { encoding: 'utf-8', timeout: 120_000, env: CHILD_ENV })
  expect(r.status, r.stderr).toBe(0)
  return JSON.parse(r.stdout)
}

describe.skipIf(!PYTHON)('promptHidden on a real terminal (pty)', () => {
  const pw = 'S3cr3t-Typed-Value'
  const res = runOnPty(pw)
  const afterFirstPrompt = res.out.slice(res.out.indexOf('New password: ') + 'New password: '.length)

  it('shows both prompts', () => {
    expect(res.seen1).toBe(true)
    expect(res.seen2).toBe(true)
  })

  it('never prints the typed text, in either prompt', () => {
    // the broken version echoed the whole string right after each label
    expect(res.out).not.toContain(pw)
    expect(afterFirstPrompt.replace(/Repeat password: /, '')).not.toMatch(/S3cr3t|Typed|Value/)
  })

  it('does not erase the prompt label with a line-refresh sequence', () => {
    // the broken version wrote ESC[1G ESC[0J right after the label, wiping "New password: " off the screen
    expect(res.out).not.toMatch(/\x1b\[1G|\x1b\[0J/)
  })

  it('still returns what was typed (twice) and ends each prompt with a newline', () => {
    const enc = Buffer.from(pw, 'utf-8').toString('base64')
    expect(res.out).toContain(`GOT:${enc}|${enc}`)
    expect(res.out).toMatch(/New password: \r?\n/)
    expect(res.out).toMatch(/Repeat password: \r?\n/)
  })
})
