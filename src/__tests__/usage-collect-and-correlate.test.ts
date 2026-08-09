import { describe, it, expect, vi } from 'vitest'
import { collectAndCorrelate } from '../web/token-usage.js'

// Collecting the rows and labelling them used to be wired up separately: the
// collector ran hourly from the server, the labeller only from the dashboard
// endpoint. Nothing failed and nothing logged -- the labels simply stopped.
// Measured on 2026-08-09: the last labelled row was from 07-31, and 76.5% of a
// 30-day window had no project at all.
//
// So the test that matters is not "does the labeller work" (it did) but "is it
// actually called".

describe('collecting usage', () => {
  it('labels the rows it collected', () => {
    const collect = vi.fn(async () => ({ inserted: 3, files: 1 }))
    const correlate = vi.fn()
    return collectAndCorrelate({ collect, correlate }).then(() => {
      expect(collect).toHaveBeenCalled()
      expect(correlate).toHaveBeenCalled()
    })
  })

  it('labels AFTER collecting, or it would label rows that are not there yet', async () => {
    const order: string[] = []
    await collectAndCorrelate({
      collect: async () => { order.push('collect'); return { inserted: 0, files: 0 } },
      correlate: () => { order.push('correlate') },
    })
    expect(order).toEqual(['collect', 'correlate'])
  })

  it('still returns the rows when labelling fails', async () => {
    // The rows are the data; the labels are an interpretation of it. Losing the
    // second must not cost the first.
    const result = await collectAndCorrelate({
      collect: async () => ({ inserted: 5, files: 2 }),
      correlate: () => { throw new Error('kanban unavailable') },
    })
    expect(result).toMatchObject({ inserted: 5, files: 2, correlated: false })
  })

  it('reports whether the labelling happened, rather than implying it', async () => {
    // A caller that cannot tell the difference would report a healthy collection
    // while the attribution silently rots -- which is exactly what happened.
    const ok = await collectAndCorrelate({
      collect: async () => ({ inserted: 1, files: 1 }),
      correlate: () => {},
    })
    expect(ok.correlated).toBe(true)
  })
})

describe('the callers', () => {
  const read = (rel: string) =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('node:fs').readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8') as string

  it('the periodic collector uses the combined function, not the bare one', () => {
    // The regression this pins: a timer that collects without labelling.
    const web = read('src/web.ts')
    expect(web).toContain('collectAndCorrelate()')
    expect(web).not.toMatch(/collectTokenUsage\(\)/)
  })

  it('and so does the endpoint, so the two cannot drift apart again', () => {
    const route = read('src/web/routes/token-usage.ts')
    expect(route).toContain('collectAndCorrelate()')
    expect(route).not.toContain('correlateWithKanban()')
  })
})
