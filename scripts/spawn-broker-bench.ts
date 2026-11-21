import { execFile, execFileSync } from 'node:child_process'
import { writeSync } from 'node:fs'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { logger } from '../src/logger.js'
import { brokerExecFile, brokerExecFileSync, spawnBrokerActive, startSpawnBroker, stopSpawnBroker } from '../src/web/spawn-broker.js'

// Touch every page and retain the allocation throughout all four modes.
const retained = Buffer.alloc(1100 * 1024 * 1024, 1)
;(globalThis as typeof globalThis & { spawnBrokerBenchMemory: Buffer }).spawnBrokerBenchMemory = retained
const rss_mb = process.memoryUsage().rss / 1024 / 1024
logger.level = 'silent' // stdout contains exactly one machine-readable result.
const options = { timeout: 3000 }
const meta = { readOnly: true }
function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return { median: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1)! }
}
async function measure(mode: string) {
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  const blocks: number[] = []
  histogram.enable()
  await delay(50)
  for (let i = 0; i < 40; i++) {
    const start = performance.now()
    let completion: Promise<unknown> | undefined
    if (mode === 'direct_execFileSync') execFileSync('/bin/true', [], options)
    else if (mode === 'brokerExecFileSync') brokerExecFileSync('/bin/true', [], options, meta)
    else if (mode === 'direct_execFile') completion = new Promise<void>((resolve, reject) => {
      execFile('/bin/true', [], options, err => { if (err) reject(err); else resolve() })
    })
    else completion = brokerExecFile('/bin/true', [], options, meta)
    blocks.push(performance.now() - start)
    await completion
    await delay(50)
  }
  histogram.disable()
  return { ...percentiles(blocks), event_loop_delay: {
    p50: histogram.percentile(50) / 1e6, p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6,
  } }
}
try {
  startSpawnBroker()
  const deadline = performance.now() + 5000
  while (!spawnBrokerActive()) {
    if (performance.now() > deadline) throw new Error('Spawn broker did not start')
    await delay(10)
  }
  const modes: Record<string, Awaited<ReturnType<typeof measure>>> = {}
  for (const mode of ['direct_execFileSync', 'brokerExecFileSync', 'direct_execFile', 'brokerExecFile']) modes[mode] = await measure(mode)
  writeSync(1, JSON.stringify({ rss_mb, ...modes }) + '\n')
} finally { await stopSpawnBroker() }
