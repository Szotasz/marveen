import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectTokenUsageAndCheckBudgets } from '../web/agent-budget-alerts.js'

describe('collectTokenUsageAndCheckBudgets', () => {
  it('calls check exactly once, after collect resolved', async () => {
    const order: string[] = []
    const collect = vi.fn(async () => { await Promise.resolve(); order.push('collect-resolved') })
    const check = vi.fn(() => { order.push('check') })
    await collectTokenUsageAndCheckBudgets(collect, check)
    expect(check).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['collect-resolved', 'check'])
  })
  it('propagates a collect rejection unchanged and skips check', async () => {
    const err = new Error('collect failed')
    const check = vi.fn()
    await expect(collectTokenUsageAndCheckBudgets(vi.fn(() => Promise.reject(err)), check)).rejects.toBe(err)
    expect(check).not.toHaveBeenCalled()
  })
  it('resolves when check throws', async () => {
    const check = vi.fn(() => { throw new Error('boom') })
    await expect(collectTokenUsageAndCheckBudgets(vi.fn(async () => undefined), check)).resolves.toBeUndefined()
    expect(check).toHaveBeenCalledTimes(1)
  })
})

describe('web.ts wiring', () => {
  // Full-line comments are dropped, so a commented-out call site does not count.
  const src = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8').replace(/^\s*\/\/.*$/gm, '')
  const call = 'collectTokenUsageAndCheckBudgets(collectTokenUsage, checkAgentBudgets)'
  it('uses the helper exactly twice and never calls collectTokenUsage() directly', () => {
    expect(src.split(call).length - 1).toBe(2)
    expect(src.match(/\bcollectTokenUsage\(\)/g) ?? []).toHaveLength(0)
  })
  it('has one call in the hourly interval and one after it at startup', () => {
    const start = src.indexOf('const tokenCollectInterval')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('}, 60 * 60 * 1000)', start)
    expect(end).toBeGreaterThan(start)
    expect(src.slice(start, end)).toContain(call)
    const after = src.slice(end)
    expect(after).toContain(call)
    const startup = after.indexOf(call)
    expect(after.lastIndexOf('if (!webOnly)', startup)).toBeGreaterThan(-1)
    expect(startup).toBeLessThan(after.indexOf('Token usage auto-collect started'))
  })
})
