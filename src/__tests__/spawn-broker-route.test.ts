import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'

describe('A5 central tmux helpers route through the broker', () => {
  it('proves all four helpers and both capture branches by their real parent PID, with a direct control', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'marveen-spawn-route-'))
    const path = process.env.PATH
    const logEnv = process.env.SPAWN_BROKER_ROUTE_LOG
    const log = join(directory, 'calls')
    let broker: typeof import('../web/spawn-broker.js') | undefined
    try {
      writeFileSync(join(directory, 'tmux'), `#!/bin/sh
printf '%s %s\\n' "$PPID" "$*" >> "$SPAWN_BROKER_ROUTE_LOG"
while [ "$#" -gt 0 ]; do
  case "$1" in
    display-message) shift; shift; printf '%s\\n' "$1" ;;
    capture-pane) printf 'pane\\n' ;;
    list-sessions) printf 'route-session\\n' ;;
  esac
  shift
done
`, { mode: 0o755 })
      process.env.PATH = `${directory}:${path}`
      process.env.SPAWN_BROKER_ROUTE_LOG = log
      vi.resetModules()
      broker = await import('../web/spawn-broker.js')
      const agent = await import('../web/agent-process.js')
      broker.startSpawnBroker()
      const deadline = performance.now() + 3000
      while (!broker.spawnBrokerActive()) {
        if (performance.now() > deadline) throw new Error('Route broker did not start')
        await delay(10)
      }
      const pid = Number(broker.brokerExecFileSync('/bin/sh', ['-c', 'printf "$PPID"'], { timeout: 1000, encoding: 'utf-8' }, { readOnly: true }))
      const exercise = async () => {
        expect(agent.sendEnterToSession('route-session')).toBe(true) // runTmux
        expect(agent.capturePane('route-session')).toBe('pane\n') // final captureTmux
        agent.withTmuxBatch(() => {
          expect(agent.sessionExistsOnHost(null, 'route-session')).toBe(true) // batched captureTmux
          expect(agent.sessionExistsOnHost(null, 'route-session')).toBe(true) // memoized
          agent.prefetchPaneCaptures(['route-a', 'route-b'])
          expect(agent.capturePane('route-a')).toBe('pane\n')
          expect(agent.capturePane('route-b')).toBe('pane\n')
        })
        expect(await agent.capturePaneAsync('route-session')).toBe('pane\n') // captureTmuxAsync
      }
      await exercise()
      const lines = readFileSync(log, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(5)
      expect(lines.map(line => Number(line.split(' ')[0]))).toEqual(Array(5).fill(pid))
      expect(lines[0]).toContain('send-keys')
      expect(lines[1]).toContain('capture-pane')
      expect(lines[2]).toContain('list-sessions')
      expect(lines[3]).toContain('__marveen_capture_')
      expect(lines[4]).toContain('capture-pane')
      await broker.stopSpawnBroker()
      expect(() => process.kill(pid, 0)).toThrow()
      writeFileSync(log, '')
      await exercise()
      expect(readFileSync(log, 'utf8').trim().split('\n').map(line => Number(line.split(' ')[0])))
        .toEqual(Array(5).fill(process.pid))
    } finally {
      await broker?.stopSpawnBroker()
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
      if (logEnv === undefined) delete process.env.SPAWN_BROKER_ROUTE_LOG
      else process.env.SPAWN_BROKER_ROUTE_LOG = logEnv
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
