// Deleting an idea took its attachments along but left its comments in idea_comments, where nothing reads them again.
// Now the comments go with the idea. Its idea_status_log rows stay: that table is an audit log (the audit page reads
// it, AUDIT_LOG_RETENTION_DAYS prunes it), so it outlives the idea on purpose.
import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase, createIdea, deleteIdea, addIdeaComment, getIdeaComments,
  addIdeaAttachment, listIdeaAttachments, logIdeaStatusChange, getIdeaStatusLog,
} from '../db.js'

const idea = (id: string) => ({
  id, title: id, description: null, category: 'test', scope: 'munka' as const, status: 'new' as const,
  source: 'manual', kanban_id: null, impact: null, effort: null,
})

describe('deleting an idea', () => {
  beforeAll(() => {
    initDatabase(':memory:')
    for (const id of ['gone', 'kept']) {
      createIdea(idea(id))
      addIdeaComment(id, 'owner', `a comment on ${id}`)
      addIdeaAttachment({ id: `att-${id}`, idea_id: id, filename: 'a.txt', stored_path: `x/${id}.txt`, mime: 'text/plain', size: 1, extracted_text: null, created_at: 1 })
      logIdeaStatusChange(id, null, 'new', 'owner')
    }
    expect(deleteIdea('gone')).toBe(true)
  })

  it('takes its comments along, with its attachments', () => {
    expect(getIdeaComments('gone')).toEqual([])
    expect(listIdeaAttachments('gone')).toEqual([])
  })

  it('leaves its status log rows: they are the audit log', () => {
    expect(getIdeaStatusLog('gone').length).toBe(1)
  })

  it('touches no other idea', () => {
    expect(getIdeaComments('kept').length).toBe(1)
    expect(listIdeaAttachments('kept').length).toBe(1)
    expect(getIdeaStatusLog('kept').length).toBe(1)
  })

  it('a missing idea answers false', () => {
    expect(deleteIdea('never-was')).toBe(false)
  })
})
