import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: { file: string; args: string[]; opts: unknown }[] = []
let collision = false
let mode = 'normal'
const panes: Record<string, string> = { a: 'A\n\n', b: '\nB\n', c: 'C\n', d: 'D\n' }

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: (file: string, args: string[], opts: unknown) => {
    calls.push({ file, args, opts })
    let out = ''
    let marker = ''
    const commands: string[][] = [[]]
    for (const arg of args) {
      if (arg === ';') commands.push([])
      else commands.at(-1)!.push(arg)
    }
    for (const command of commands) {
      if (command[0] === 'display-message') {
        marker = command[2]
        out += marker + '\n'
      } else {
        const session = command[command.indexOf('-t') + 1].slice(1, -1)
        if (args.includes(';') && session === 'b') {
          if (mode === 'stdout-getter') {
            throw Object.defineProperty(new Error('spawn failed'), 'stdout', {
              get() { throw new Error('unreadable stdout') },
            })
          }
          if (['partial', 'partial-tail', 'echo-partial'].includes(mode)) {
            throw Object.assign(new Error('missing'), {
              stdout: Buffer.from(out + (mode === 'partial-tail' ? 'x' : '')), status: 1,
            })
          }
          if (['timeout', 'exit-2', 'timeout-tmux36', 'timeout-status1', 'echo-timeout'].includes(mode)) {
            // timeout-status1 ends at the marker so that only the error code separates this timeout from a vanished session.
            if (mode !== 'echo-timeout' && mode !== 'timeout-status1') out += panes.b[0]
            throw Object.assign(new Error('spawnSync tmux ETIMEDOUT'), {
              code: mode === 'exit-2' ? undefined : 'ETIMEDOUT',
              stdout: mode === 'echo-timeout' ? out.slice(0, out.indexOf(marker + '\n') + marker.length + 1) : out,
              // Measured tmux 3.6 timeout shape: status 0, signal null, code ETIMEDOUT.
              status: mode === 'timeout-tmux36' ? 0 : mode === 'timeout-status1' ? 1 : mode === 'exit-2' ? 2 : null,
              signal: mode === 'timeout' || mode === 'echo-timeout' ? 'SIGTERM' : null,
            })
          }
        }
        out += panes[session]
        if (args.includes(';') && session === 'a' && ['echo-timeout', 'echo-partial'].includes(mode)) {
          out += commands[2][2] + '\n'
        }
        if (collision && marker) out += marker + '\n'
      }
    }
    if (args.includes(';')) {
      if (mode === 'swapped') {
        const first = commands[2][2]
        const second = commands[4][2]
        return out.replaceAll(first, 'SWAP').replaceAll(second, first).replaceAll('SWAP', second)
      }
      if (mode === 'prefix') return 'noise\n' + out
      if (mode === 'short') return out.slice(0, out.indexOf(commands[2][2]))
      if (mode === 'embedded') return out.replace('A\n', `A${marker}\n`)
      if (mode === 'separator') return out.replace(`\n${marker}`, `\r${marker}`)
      if (mode === 'order') return out.replace(commands[0][2], marker)
      if (mode === 'empty-error') throw new Error('spawn failed')
    }
    return out
  } }
})

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...actual, listAgentNames: () => ['user'], readAgentRunAsUser: () => 'svc-test', readAgentRemoteHost: () => null }
})

const { prefetchPaneCaptures, capturePane, withTmuxBatch } = await import('../web/agent-process.js')

beforeEach(() => { calls.length = 0; collision = false; mode = 'normal' })

describe('pane capture prefetch', () => {
  it('does nothing outside a batch', () => {
    prefetchPaneCaptures(['a', 'b'])
    expect(calls).toHaveLength(0)
  })

  it('deduplicates in order and consumes frames only once', () => {
    withTmuxBatch(() => {
      prefetchPaneCaptures(['a', 'b', 'a'])
      expect(capturePane('a')).toBe(panes.a)
      expect(capturePane('b')).toBe(panes.b)
      expect(calls).toHaveLength(1)
      expect(capturePane('a')).toBe(panes.a)
      expect(calls).toHaveLength(2)
    })
    const { args, opts } = calls[0]
    expect(args).toEqual([
      'display-message', '-p', expect.stringMatching(/^__marveen_capture_[0-9a-f]{32}_0__$/), ';',
      'capture-pane', '-t', '=a:', '-e', '-p', ';',
      'display-message', '-p', args[2].replace('_0__', '_1__'), ';',
      'capture-pane', '-t', '=b:', '-e', '-p',
    ])
    expect(opts).toEqual({ timeout: 3400, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  })

  it.each([[], ['a'], ['a', 'a'], ['a', 'agent-user']].map(sessions => ({ sessions })))('does not spawn for fewer than two eligible sessions: $sessions', ({ sessions }) => {
    withTmuxBatch(() => prefetchPaneCaptures(sessions))
    expect(calls).toHaveLength(0)
  })

  it('rejects a real nonce echoed inside a pane', () => {
    collision = true
    withTmuxBatch(() => {
      prefetchPaneCaptures(['a', 'b'])
      expect(capturePane('a')).toBe(panes.a)
      expect(capturePane('b')).toBe(panes.b)
    })
    expect(calls).toHaveLength(3)
  })

  it.each(['prefix', 'short', 'embedded', 'order', 'separator', 'empty-error'])('falls back for %s output', (value) => {
    mode = value
    withTmuxBatch(() => {
      prefetchPaneCaptures(['a', 'b'])
      expect(capturePane('a')).toBe(panes.a)
      expect(capturePane('b')).toBe(panes.b)
    })
    expect(calls).toHaveLength(3)
  })

  it.each(['timeout', 'exit-2', 'timeout-tmux36', 'timeout-status1', 'echo-timeout'])('stores nothing and falls back individually after %s', (value) => {
    mode = value
    withTmuxBatch(() => {
      prefetchPaneCaptures(['a', 'b', 'c', 'd'])
      expect(capturePane('a')).toBe(panes.a)
      expect(calls).toHaveLength(2)
      expect(capturePane('b')).toBe(panes.b)
      expect(capturePane('c')).toBe(panes.c)
      expect(capturePane('d')).toBe(panes.d)
    })
    expect(calls).toHaveLength(5)
    expect(calls.slice(1).some(call => call.args.includes(';'))).toBe(false)
  })

  it('a positional failure needs the output to end at the last marker', () => {
    mode = 'partial-tail'
    withTmuxBatch(() => {
      prefetchPaneCaptures(['a', 'b', 'c', 'd'])
      for (const session of ['a', 'b', 'c', 'd']) expect(capturePane(session)).toBe(panes[session])
    })
    expect(calls).toHaveLength(5)
    expect(calls.slice(1).some(call => call.args.includes(';'))).toBe(false)
  })

  it('an echoed marker before a positional failure stores nothing', () => {
    mode = 'echo-partial'
    withTmuxBatch(() => {
      prefetchPaneCaptures(['a', 'b', 'c', 'd'])
      for (const session of ['a', 'b', 'c', 'd']) expect(capturePane(session)).toBe(panes[session])
    })
    expect(calls).toHaveLength(5)
    expect(calls.slice(1).some(call => call.args.includes(';'))).toBe(false)
  })

  it('rejects swapped middle markers', () => {
    mode = 'swapped'
    withTmuxBatch(() => {
      prefetchPaneCaptures(['a', 'b', 'c'])
      for (const session of ['a', 'b', 'c']) expect(capturePane(session)).toBe(panes[session])
    })
    expect(calls).toHaveLength(4)
    expect(calls.slice(1).some(call => call.args.includes(';'))).toBe(false)
  })

  it('never throws out of the prefetch', () => {
    mode = 'stdout-getter'
    withTmuxBatch(() => {
      expect(() => prefetchPaneCaptures(['a', 'b'])).not.toThrow()
      expect(capturePane('a')).toBe(panes.a)
      expect(capturePane('b')).toBe(panes.b)
    })
    expect(calls).toHaveLength(3)
    expect(calls.slice(1).some(call => call.args.includes(';'))).toBe(false)
  })

  it('uses Buffer stdout on failure and retries only the remainder with a fresh nonce', () => {
    mode = 'partial'
    withTmuxBatch(() => {
      prefetchPaneCaptures(['a', 'b', 'c', 'd'])
      expect(capturePane('a')).toBe(panes.a)
      expect(capturePane('b')).toBeNull()
      expect(capturePane('c')).toBe(panes.c)
      expect(capturePane('d')).toBe(panes.d)
      expect(calls).toHaveLength(2)
      expect(capturePane('b')).toBe(panes.b)
    })
    expect(calls).toHaveLength(3)
    expect(calls[1].args[2]).not.toBe(calls[0].args[2])
    expect(calls[1].args.flatMap((arg, i, args) => arg === 'capture-pane' ? [args[i + 2]] : [])).toEqual(['=c:', '=d:'])
  })
})
