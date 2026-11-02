// The kanban section of templates/CLAUDE.md.template tells the main agent which
// fields of the done answer to read. scripts/marveen-api.sh exits 0 on every
// HTTP 200, so these fields are the only signal of how a close went. Each field
// the template names is produced here by the route, in the situation the
// template describes, so the text cannot drift from what the answer carries.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { initDatabase, createKanbanCard, moveKanbanCard, addCardBlocker, getKanbanCard } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import { MAIN_AGENT_ID } from '../config.js'
import type { RouteContext } from '../web/routes/types.js'

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'CLAUDE.md.template')

function kanbanSection(): string {
  const text = readFileSync(TEMPLATE, 'utf-8')
  const start = text.indexOf('## Kanban tábla')
  const end = text.indexOf('\n## ', start + 1)
  expect(start).toBeGreaterThanOrEqual(0)
  return text.slice(start, end < 0 ? undefined : end)
}

async function move(id: string, body: Record<string, unknown>) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = Readable.from([Buffer.from(JSON.stringify(body))])
  req.headers = {}
  const url = new URL(`http://localhost:3420/api/kanban/${id}/move`)
  expect(await tryHandleKanban({ req, res, path: url.pathname, method: 'POST', url } as RouteContext)).toBe(true)
  return out
}

describe('the template names the fields the done answer really carries', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createKanbanCard({ id: 'c1', title: 'Work' })
    moveKanbanCard('c1', 'in_progress', 0, MAIN_AGENT_ID)
  })

  it('an agent close without evidence: HTTP 200, "ok": false, "evidence_required": true, card in testing', async () => {
    const section = kanbanSection()
    expect(section).toContain('`"ok": false`')
    expect(section).toContain('`"evidence_required": true`')
    const r = await move('c1', { status: 'done', actor: MAIN_AGENT_ID, expected_status: 'in_progress' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: false, evidence_required: true, status: 'testing' })
    expect(getKanbanCard('c1')!.status).toBe('testing')
  })

  it('a close with no actor and no evidence goes through and carries evidence_warning while no comment exists', async () => {
    expect(kanbanSection()).toContain('`evidence_warning`')
    expect(kanbanSection()).toContain('`--actor` nélkül')
    // the body the template's kanban-move recipe sends when --evidence-file is left out
    const r = await move('c1', { status: 'done', expected_status: 'in_progress' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.evidence_warning).toContain('/api/kanban/c1/comments')
    expect(getKanbanCard('c1')!.status).toBe('done')
  })

  it('the template recipe (evidence, no actor) closes the card without a warning', async () => {
    const r = await move('c1', { status: 'done', expected_status: 'in_progress', evidence: 'vitest 12 pass' })
    expect(r.body).toEqual({ ok: true })
    expect(getKanbanCard('c1')!.status).toBe('done')
  })

  it('unblocked lists the waiting card the close sent back to planned', async () => {
    expect(kanbanSection()).toContain('`unblocked`')
    createKanbanCard({ id: 'w1', title: 'Waits for c1' })
    moveKanbanCard('w1', 'waiting', 0)
    addCardBlocker('w1', 'c1')
    const r = await move('c1', { status: 'done', expected_status: 'in_progress', evidence: 'done, PR #1' })
    expect(r.body.ok).toBe(true)
    expect(r.body.unblocked.map((u: { id: string }) => u.id)).toEqual(['w1'])
    expect(getKanbanCard('w1')!.status).toBe('planned')
  })
})
