import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { extname, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { MAIN_AGENT_ID, BOT_NAME, PROJECT_ROOT } from '../../config.js'
import { listIdeas, createIdea, updateIdea, deleteIdea, listIdeaCategories, createKanbanCard, getDb, getIdeaComments, addIdeaComment, logIdeaStatusChange, getIdeaStatusLog, listIdeaAttachments, getIdeaAttachment, addIdeaAttachment, deleteIdeaAttachment } from '../../db.js'
import { generateBreakdown } from '../llm-breakdown.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { parseMultipart } from '../multipart.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import type { RouteContext } from './types.js'

type IdeaRow = import('../../db.js').IdeaBoxRow

function getIdea(id: string): IdeaRow | undefined {
  return getDb().prepare('SELECT * FROM idea_box WHERE id = ?').get(id) as IdeaRow | undefined
}

const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent'])
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const ATTACHMENTS_ROOT = resolve(PROJECT_ROOT, 'store', 'idea-attachments')
const execFileAsync = promisify(execFile)
const ALLOWED_ATTACHMENT_TYPES: Record<string, Set<string>> = {
  '.pdf': new Set(['application/pdf']),
  '.png': new Set(['image/png']),
  '.jpg': new Set(['image/jpeg']),
  '.jpeg': new Set(['image/jpeg']),
  '.gif': new Set(['image/gif']),
  '.webp': new Set(['image/webp']),
  '.txt': new Set(['text/plain']),
  '.md': new Set(['text/markdown', 'text/plain', 'application/octet-stream']),
  '.csv': new Set(['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel']),
  '.docx': new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream']),
  '.xlsx': new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream']),
}

function safeAttachmentFilename(name: string): string {
  const leaf = name.replace(/^.*[\\/]/, '')
  return (leaf.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^\.+/, '').slice(0, 100) || 'attachment')
}

function attachmentAbsolutePath(storedPath: string): string | null {
  const fullPath = resolve(PROJECT_ROOT, storedPath)
  const rel = relative(ATTACHMENTS_ROOT, fullPath)
  return rel && !rel.startsWith(`..${sep}`) && rel !== '..' ? fullPath : null
}

// `stored_path` is a server filesystem path and `extracted_text` can be large:
// neither belongs in a client response. The client addresses an attachment by id
// through the download route, so it never needs the path.
function publicAttachment(row: import('../../db.js').IdeaAttachmentRow) {
  const { extracted_text: extractedText, stored_path: _storedPath, ...rest } = row
  return { ...rest, has_text: Boolean(extractedText?.trim()) }
}

async function readAttachmentUpload(req: RouteContext['req'], res: RouteContext['res']) {
  const declaredLength = Number(req.headers['content-length'] || 0)
  if (declaredLength > MAX_ATTACHMENT_BYTES + 1024 * 1024) {
    json(res, { error: 'A fájl legfeljebb 20 MB lehet' }, 413); return null
  }
  let body: Buffer
  try {
    body = await readBody(req, { maxBytes: MAX_ATTACHMENT_BYTES + 1024 * 1024 })
  } catch {
    json(res, { error: 'A fájl legfeljebb 20 MB lehet' }, 413); return null
  }
  const { file } = parseMultipart(body, req.headers['content-type'] || '')
  if (!file) { json(res, { error: 'Nincs feltöltött fájl' }, 400); return null }
  if (file.data.length > MAX_ATTACHMENT_BYTES) { json(res, { error: 'A fájl legfeljebb 20 MB lehet' }, 413); return null }
  const extension = extname(file.name).toLowerCase()
  const allowedMimes = ALLOWED_ATTACHMENT_TYPES[extension]
  const mime = file.mime.toLowerCase().split(';', 1)[0].trim()
  if (!allowedMimes?.has(mime)) { json(res, { error: 'Ez a fájltípus nem tölthető fel' }, 415); return null }
  return { file, extension, mime }
}

async function storeIdeaAttachment(ideaId: string, upload: NonNullable<Awaited<ReturnType<typeof readAttachmentUpload>>>) {
  const { file, extension, mime } = upload
  const id = randomUUID().slice(0, 8)
  const filename = file.name.replace(/^.*[\\/]/, '').slice(0, 255) || 'attachment'
  const ideaDir = resolve(ATTACHMENTS_ROOT, ideaId)
  const ideaRel = relative(ATTACHMENTS_ROOT, ideaDir)
  if (!ideaRel || ideaRel.startsWith(`..${sep}`) || ideaRel === '..') throw new Error('Invalid idea attachment directory')
  mkdirSync(ideaDir, { recursive: true })
  const filePath = resolve(ideaDir, `${id}-${safeAttachmentFilename(filename)}`)
  const storedPath = relative(PROJECT_ROOT, filePath)
  try {
    writeFileSync(filePath, file.data)
    let extractedText: string | null = null
    if (extension === '.pdf') {
      try { extractedText = await extractPdfText(filePath) }
      catch (err) { logger.warn({ err, ideaId, attachmentId: id }, 'PDF text extraction failed') }
    }
    const row: import('../../db.js').IdeaAttachmentRow = {
      id, idea_id: ideaId, filename, stored_path: storedPath, mime, size: file.data.length,
      extracted_text: extractedText, created_at: Math.floor(Date.now() / 1000),
    }
    addIdeaAttachment(row)
    return row
  } catch (err) {
    try { unlinkSync(filePath) } catch { /* best effort */ }
    throw err
  }
}

async function extractPdfText(filePath: string): Promise<string | null> {
  const script = resolve(PROJECT_ROOT, 'scripts', 'muhely', 'pdftext.py')
  const { stdout } = await execFileAsync('python3', [script, filePath], {
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf8',
  })
  return stdout.trim() || null
}

export async function tryHandleIdeas(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // Configurable stale threshold -- ideas with status 'new' older than this many days
  // are flagged with stale:true in the list response. Read live through the settings
  // layer (config-overrides.json > .env > default) so a Settings-page change applies
  // without a restart.
  const IDEA_STALE_DAYS = Math.max(1, Number(getEffectiveSettingValue('IDEA_STALE_DAYS')) || 7)

  if (path === '/api/ideas' && method === 'GET') {
    const status = url.searchParams.get('status') || undefined
    const category = url.searchParams.get('category') || undefined
    const ideas = listIdeas({ status, category })
    const staleCutoff = Math.floor(Date.now() / 1000) - IDEA_STALE_DAYS * 86400
    json(res, ideas.map(i => ({ ...i, stale: i.status === 'new' && i.updated_at < staleCutoff })))
    return true
  }

  if (path === '/api/ideas/categories' && method === 'GET') {
    json(res, listIdeaCategories())
    return true
  }

  const attachmentDownloadMatch = path.match(/^\/api\/ideas\/attachments\/([^/]+)\/download$/)
  if (attachmentDownloadMatch && method === 'GET') {
    const attachment = getIdeaAttachment(decodeURIComponent(attachmentDownloadMatch[1]))
    if (!attachment) { json(res, { error: 'Csatolmány nem található' }, 404); return true }
    const filePath = attachmentAbsolutePath(attachment.stored_path)
    if (!filePath) { json(res, { error: 'Érvénytelen csatolmány útvonal' }, 400); return true }
    if (!existsSync(filePath)) { json(res, { error: 'A csatolmány fájlja nem található' }, 404); return true }
    const downloadName = safeAttachmentFilename(attachment.filename).replace(/"/g, '_')
    res.writeHead(200, {
      'Content-Type': attachment.mime,
      'Content-Disposition': `attachment; filename="${downloadName}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      'Cache-Control': 'private, no-store',
    })
    createReadStream(filePath).pipe(res)
    return true
  }

  const attachmentActionMatch = path.match(/^\/api\/ideas\/attachments\/([^/]+)$/)
  if (attachmentActionMatch && method === 'DELETE') {
    const id = decodeURIComponent(attachmentActionMatch[1])
    const attachment = getIdeaAttachment(id)
    if (!attachment) { json(res, { error: 'Csatolmány nem található' }, 404); return true }
    const filePath = attachmentAbsolutePath(attachment.stored_path)
    if (filePath) {
      try { unlinkSync(filePath) } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn({ err, attachmentId: id }, 'Failed to delete idea attachment file')
        else logger.info({ attachmentId: id }, 'Idea attachment file already missing')
      }
    } else {
      logger.warn({ attachmentId: id, storedPath: attachment.stored_path }, 'Refusing to delete attachment outside storage root')
    }
    deleteIdeaAttachment(id)
    json(res, { ok: true })
    return true
  }

  const attachmentsMatch = path.match(/^\/api\/ideas\/([^/]+)\/attachments$/)
  if (attachmentsMatch && method === 'GET') {
    const ideaId = decodeURIComponent(attachmentsMatch[1])
    if (!getIdea(ideaId)) { json(res, { error: 'Ötlet nem található' }, 404); return true }
    json(res, { attachments: listIdeaAttachments(ideaId).map(publicAttachment) })
    return true
  }

  if (attachmentsMatch && method === 'POST') {
    const ideaId = decodeURIComponent(attachmentsMatch[1])
    if (!getIdea(ideaId)) { json(res, { error: 'Ötlet nem található' }, 404); return true }
    const upload = await readAttachmentUpload(req, res)
    if (!upload) return true
    const row = await storeIdeaAttachment(ideaId, upload)
    json(res, publicAttachment(row))
    return true
  }

  if (path === '/api/ideas/upload' && method === 'POST') {
    const upload = await readAttachmentUpload(req, res)
    if (!upload) return true
    const id = randomUUID().slice(0, 8)
    const filename = upload.file.name.replace(/^.*[\\/]/, '').slice(0, 255) || 'attachment'
    const titleWithoutExtension = upload.extension ? filename.slice(0, -upload.extension.length).trim() : filename.trim()
    const title = (titleWithoutExtension || filename.trim() || filename).slice(0, 120)
    createIdea({
      id,
      title,
      description: null,
      category: 'Egyéb',
      status: 'new',
      source: 'upload',
      kanban_id: null,
      impact: null,
      effort: null,
    })
    let attachment: import('../../db.js').IdeaAttachmentRow | undefined
    try {
      attachment = await storeIdeaAttachment(id, upload)
      if (attachment.extracted_text && !updateIdea(id, { description: attachment.extracted_text.slice(0, 2000) })) {
        throw new Error('Failed to update uploaded idea description')
      }
    } catch (err) {
      if (attachment) {
        const filePath = attachmentAbsolutePath(attachment.stored_path)
        if (filePath) try { unlinkSync(filePath) } catch { /* best effort */ }
      }
      try { deleteIdea(id) } catch (cleanupErr) { logger.error({ err: cleanupErr, ideaId: id }, 'Failed to clean up idea after upload failure') }
      throw err
    }
    json(res, { idea: getIdea(id), attachment: publicAttachment(attachment) })
    return true
  }

  if (path === '/api/ideas' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      title: string
      description?: string
      category?: string
      source?: string
      impact?: number | null
      effort?: number | null
    }
    if (!data.title) { json(res, { error: 'title required' }, 400); return true }
    // Same 1-5 validation as PUT -- previously POST silently dropped these fields
    let impact: number | null = null
    if (data.impact !== undefined && data.impact !== null) {
      const v = Math.round(Number(data.impact))
      if (!Number.isFinite(v) || v < 1 || v > 5) { json(res, { error: 'impact must be 1-5 or null' }, 400); return true }
      impact = v
    }
    let effort: number | null = null
    if (data.effort !== undefined && data.effort !== null) {
      const v = Math.round(Number(data.effort))
      if (!Number.isFinite(v) || v < 1 || v > 5) { json(res, { error: 'effort must be 1-5 or null' }, 400); return true }
      effort = v
    }
    const id = randomUUID().slice(0, 8)
    createIdea({
      id,
      title: data.title,
      description: data.description ?? null,
      category: data.category ?? 'Egyéb',
      status: 'new',
      source: data.source ?? 'manual',
      kanban_id: null,
      impact,
      effort,
    })
    json(res, { ok: true, id })
    return true
  }

  const ideaMatch = path.match(/^\/api\/ideas\/([^/]+)$/)

  if (ideaMatch && method === 'PUT') {
    const id = decodeURIComponent(ideaMatch[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      title?: string
      description?: string
      category?: string
      status?: IdeaRow['status']
      kanban_id?: string
      impact?: number | null
      effort?: number | null
    }
    // Coerce impact/effort to int or null -- reject values outside 1-5
    if (data.impact !== undefined && data.impact !== null) {
      const v = Math.round(Number(data.impact))
      if (!Number.isFinite(v) || v < 1 || v > 5) { json(res, { error: 'impact must be 1-5 or null' }, 400); return true }
      data.impact = v
    }
    if (data.effort !== undefined && data.effort !== null) {
      const v = Math.round(Number(data.effort))
      if (!Number.isFinite(v) || v < 1 || v > 5) { json(res, { error: 'effort must be 1-5 or null' }, 400); return true }
      data.effort = v
    }
    const current = getIdea(id)
    if (!current) { json(res, { error: 'Ötlet nem található' }, 404); return true }
    if (updateIdea(id, data)) {
      if (data.status && data.status !== current.status) {
        logIdeaStatusChange(id, current.status, data.status, MAIN_AGENT_ID)
      }
      json(res, { ok: true })
      return true
    }
    json(res, { error: 'Ötlet nem található' }, 404)
    return true
  }

  if (ideaMatch && method === 'DELETE') {
    const id = decodeURIComponent(ideaMatch[1])
    const attachments = listIdeaAttachments(id)
    if (deleteIdea(id)) {
      for (const attachment of attachments) {
        const filePath = attachmentAbsolutePath(attachment.stored_path)
        if (!filePath) { logger.warn({ attachmentId: attachment.id }, 'Refusing to delete attachment outside storage root'); continue }
        try { unlinkSync(filePath) } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn({ err, attachmentId: attachment.id }, 'Failed to delete idea attachment file')
          else logger.info({ attachmentId: attachment.id }, 'Idea attachment file already missing')
        }
      }
      json(res, { ok: true }); return true
    }
    json(res, { error: 'Ötlet nem található' }, 404)
    return true
  }

  // Idea comments
  const commentsMatch = path.match(/^\/api\/ideas\/([^/]+)\/comments$/)

  if (commentsMatch && method === 'GET') {
    const ideaId = decodeURIComponent(commentsMatch[1])
    json(res, { comments: getIdeaComments(ideaId) })
    return true
  }

  if (commentsMatch && method === 'POST') {
    const ideaId = decodeURIComponent(commentsMatch[1])
    const body = await readBody(req)
    const { author, content } = JSON.parse(body.toString()) as { author?: string; content?: string }
    if (!content || typeof content !== 'string' || !content.trim()) {
      json(res, { error: 'content required' }, 400); return true
    }
    const comment = addIdeaComment(ideaId, author?.trim() || MAIN_AGENT_ID, content.trim())
    json(res, { ok: true, comment })
    return true
  }

  // Promote idea to kanban card
  const promoteMatch = path.match(/^\/api\/ideas\/([^/]+)\/promote$/)
  if (promoteMatch && method === 'POST') {
    const ideaId = decodeURIComponent(promoteMatch[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { phase?: 'detail' | 'plan' }
    const phase = data.phase ?? 'detail'

    const idea = (getDb().prepare('SELECT * FROM idea_box WHERE id = ?').get(ideaId) as import('../../db.js').IdeaBoxRow | undefined)
    if (!idea) { json(res, { error: 'Ötlet nem található' }, 404); return true }

    const cardId = randomUUID().slice(0, 8)
    const status = phase === 'plan' ? 'planned' : 'waiting'
    const title = phase === 'plan' ? idea.title : `[Részlet kidolgozás] ${idea.title}`
    createKanbanCard({
      id: cardId,
      title,
      description: idea.description ?? '',
      status,
      priority: 'normal',
      assignee: BOT_NAME,
      project: 'Fejlesztési ötletek',
    })
    logIdeaStatusChange(ideaId, idea.status, 'kanban', MAIN_AGENT_ID, `promote:${phase}`)
    updateIdea(ideaId, { status: 'kanban', kanban_id: cardId })
    json(res, { ok: true, kanban_id: cardId })
    return true
  }

  // AI breakdown: elaborate the idea into 3-5 assignable subtasks (no DB write
  // yet -- the user approves per-subtask in the UI, then calls promote-breakdown).
  const breakdownMatch = path.match(/^\/api\/ideas\/([^/]+)\/breakdown$/)
  if (breakdownMatch && method === 'POST') {
    const ideaId = decodeURIComponent(breakdownMatch[1])
    const idea = getIdea(ideaId)
    if (!idea) { json(res, { error: 'Ötlet nem található' }, 404); return true }
    try {
      const result = await generateBreakdown(idea.title, idea.description)
      json(res, { subtasks: result.subtasks })
    } catch (err) {
      logger.error({ err, ideaId }, 'Idea breakdown generation failed')
      json(res, { error: (err as Error).message }, 500)
    }
    return true
  }

  // Promote an idea via approved breakdown: create a parent card from the idea +
  // one child card per approved subtask (assignee + priority), mark idea 'kanban'.
  const promoteBreakdownMatch = path.match(/^\/api\/ideas\/([^/]+)\/promote-breakdown$/)
  if (promoteBreakdownMatch && method === 'POST') {
    const ideaId = decodeURIComponent(promoteBreakdownMatch[1])
    const idea = getIdea(ideaId)
    if (!idea) { json(res, { error: 'Ötlet nem található' }, 404); return true }
    const body = await readBody(req)
    const { subtasks, success_criteria } = JSON.parse(body.toString()) as {
      subtasks: Array<{ title: string; description?: string; assignee?: string | null; priority?: string }>
      success_criteria?: string
    }
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      json(res, { error: 'Legalább egy jóváhagyott alfeladat kötelező' }, 400)
      return true
    }
    const baseDesc = idea.description ?? ''
    const parentDesc = success_criteria?.trim()
      ? `${baseDesc}\n\n## Siker-kritérium\n${success_criteria.trim()}`.trimStart()
      : baseDesc
    const parentId = randomUUID().slice(0, 8)
    createKanbanCard({
      id: parentId,
      title: idea.title,
      description: parentDesc,
      status: 'planned',
      priority: 'normal',
      assignee: BOT_NAME,
      project: 'Fejlesztési ötletek',
    })
    const childIds: string[] = []
    for (const st of subtasks) {
      if (!st.title) continue
      const childId = randomUUID().slice(0, 8)
      createKanbanCard({
        id: childId,
        title: String(st.title).slice(0, 120),
        description: (st.description ?? '').slice(0, 500),
        status: 'planned',
        priority: (st.priority && VALID_PRIORITIES.has(st.priority) ? st.priority : 'normal') as 'low' | 'normal' | 'high' | 'urgent',
        assignee: st.assignee || BOT_NAME,
        project: 'Fejlesztési ötletek',
        parent_id: parentId,
      })
      childIds.push(childId)
    }
    logIdeaStatusChange(ideaId, idea.status, 'kanban', MAIN_AGENT_ID, `promote-breakdown:${childIds.length} subtasks`)
    updateIdea(ideaId, { status: 'kanban', kanban_id: parentId })
    json(res, { ok: true, parent_id: parentId, child_count: childIds.length })
    return true
  }

  // Manual revert: kanban -> reviewed (clears kanban_id)
  const revertMatch = path.match(/^\/api\/ideas\/([^/]+)\/revert$/)
  if (revertMatch && method === 'POST') {
    const id = decodeURIComponent(revertMatch[1])
    const idea = getIdea(id)
    if (!idea) { json(res, { error: 'Ötlet nem található' }, 404); return true }
    if (idea.status !== 'kanban') { json(res, { error: 'Csak kanban státuszú ötlet vonható vissza' }, 400); return true }
    updateIdea(id, { status: 'reviewed', kanban_id: null })
    logIdeaStatusChange(id, 'kanban', 'reviewed', MAIN_AGENT_ID, 'Manuális visszavonás')
    json(res, { ok: true })
    return true
  }

  // Status audit log for an idea
  const statusLogMatch = path.match(/^\/api\/ideas\/([^/]+)\/status-log$/)
  if (statusLogMatch && method === 'GET') {
    const ideaId = decodeURIComponent(statusLogMatch[1])
    json(res, { log: getIdeaStatusLog(ideaId) })
    return true
  }

  return false
}
