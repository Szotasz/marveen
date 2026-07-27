import { describe, it, expect, vi } from 'vitest'
import { RouteDispatcher } from '../web/routes/dispatcher.js'
import type { RouteContext } from '../web/routes/types.js'

const fakeCtx = {} as RouteContext

describe('RouteDispatcher', () => {
  it('returns false with no handlers', async () => {
    const d = new RouteDispatcher()
    expect(await d.dispatch(fakeCtx)).toBe(false)
  })

  it('returns false when all handlers return false', async () => {
    const d = new RouteDispatcher()
      .add(async () => false)
      .add(async () => false)
    expect(await d.dispatch(fakeCtx)).toBe(false)
  })

  it('returns true when any handler claims the request', async () => {
    const d = new RouteDispatcher()
      .add(async () => false)
      .add(async () => true)
    expect(await d.dispatch(fakeCtx)).toBe(true)
  })

  it('short-circuits: handlers after the first truthy one are not called', async () => {
    const third = vi.fn(async () => false)
    const d = new RouteDispatcher()
      .add(async () => false)
      .add(async () => true)
      .add(third)
    await d.dispatch(fakeCtx)
    expect(third).not.toHaveBeenCalled()
  })

  it('calls handlers in registration order', async () => {
    const order: number[] = []
    const d = new RouteDispatcher()
      .add(async () => { order.push(1); return false })
      .add(async () => { order.push(2); return false })
      .add(async () => { order.push(3); return false })
    await d.dispatch(fakeCtx)
    expect(order).toEqual([1, 2, 3])
  })

  it('add() returns the dispatcher for fluent chaining', () => {
    const d = new RouteDispatcher()
    expect(d.add(async () => false)).toBe(d)
  })

  it('passes the context to each handler', async () => {
    const ctx = { path: '/test' } as unknown as RouteContext
    const received: RouteContext[] = []
    const d = new RouteDispatcher()
      .add(async (c) => { received.push(c); return false })
      .add(async (c) => { received.push(c); return false })
    await d.dispatch(ctx)
    expect(received).toEqual([ctx, ctx])
  })
})
