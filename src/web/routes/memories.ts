import {
  saveAgentMemory, getAgentMemories, searchAgentMemories, getMemoryStats, updateMemory,
  hybridSearch, backfillEmbeddings, clearMemoryCache,
  searchMemories, getMemoriesForChat, getDb, touchMemoriesAccessed,
  recordMemoryRead, recordMemoryReadBatch, getStaleMemories, getMemoryVersions,
  runMemoryMaintenance,
  type Memory,
} from '../../db.js'
import { MAIN_AGENT_ID, ALLOWED_CHAT_ID, OLLAMA_URL, APP_TZ } from '../../config.js'
import { logger } from '../../logger.js'
import { readBody, json, jsonMaybeGzip } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Canonical memory categories. Kept in sync with the DB CHECK constraint in
// src/db.ts so the API rejects bad values before they even reach SQLite.
const MEMORY_CATEGORIES = new Set(['hot', 'warm', 'cold', 'shared'])

const SUSPICIOUS_PATTERNS = [
  /\bcurl\s+(-[a-zA-Z]\s+)*https?:\/\//i,
  /\bbash\s+-c\b/i,
  /\beval\s*\(/i,
  /\bexec\s*\(/i,
  /\bimport\s+subprocess\b/i,
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /override\s+your\s+(instructions|rules|safety|guidelines)/i,
  /forget\s+your\s+(instructions|rules|safety|guidelines|training)/i,
  /new\s+persona/i,
  /\brm\s+-rf\b/i,
]

function containsSuspiciousContent(content: string): boolean {
  return SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(content))
}

export async function tryHandleMemories(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/memories' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { agent_id?: string; content: string; tier?: string; category?: string; keywords?: string }
    if (!data.content?.trim()) { json(res, { error: 'Content is required' }, 400); return true }
    if (containsSuspiciousContent(data.content)) {
      logger.warn({ agent: data.agent_id }, 'Memory content rejected: suspicious pattern')
      json(res, { error: 'Content rejected by security filter' }, 400)
      return true
    }
    if (data.tier && !data.category) {
      logger.warn({ agent: data.agent_id }, '[DEPRECATED] /api/memories: use "category" instead of "tier"')
    }
    const category = (data.category || data.tier || 'warm').toLowerCase()
    if (!MEMORY_CATEGORIES.has(category)) {
      json(res, { error: `Invalid category "${category}". Allowed: ${[...MEMORY_CATEGORIES].join(', ')}` }, 400)
      return true
    }
    const result = saveAgentMemory(
      data.agent_id || MAIN_AGENT_ID,
      data.content.trim(),
      category,
      data.keywords || undefined,
      true
    )
    json(res, { ok: true, id: result.id })
    return true
  }

  if (path === '/api/memories' && method === 'GET') {
    const q = url.searchParams.get('q')?.trim() || ''
    const agentIdAlias = url.searchParams.get('agent_id')
    if (agentIdAlias && !url.searchParams.get('agent')) {
      logger.warn({ agent_id: agentIdAlias }, '[DEPRECATED] GET /api/memories: use "agent" instead of "agent_id"')
    }
    const agentId = url.searchParams.get('agent') || agentIdAlias || ''
    const tier = url.searchParams.get('tier') || url.searchParams.get('category') || ''
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
    const mode = url.searchParams.get('mode') || 'fts'

    let results: Memory[]
    if (q && mode === 'hybrid') {
      results = await hybridSearch(agentId || MAIN_AGENT_ID, q, limit)
    } else if (q && agentId) {
      results = searchAgentMemories(agentId, q, limit)
      if (results.length === 0) {
        const db2 = getDb()
        results = db2.prepare("SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? OR keywords LIKE ?) ORDER BY accessed_at DESC LIMIT ?")
          .all(agentId, `%${q}%`, `%${q}%`, limit) as Memory[]
      }
    } else if (q) {
      results = searchMemories(q, ALLOWED_CHAT_ID, limit)
      if (results.length === 0) {
        const db2 = getDb()
        results = db2.prepare('SELECT * FROM memories WHERE content LIKE ? ORDER BY accessed_at DESC LIMIT ?').all(`%${q}%`, limit) as Memory[]
      }
    } else if (agentId) {
      results = getAgentMemories(agentId, limit)
    } else {
      results = getMemoriesForChat(ALLOWED_CHAT_ID, limit)
    }

    if (tier) results = results.filter(m => m.category === tier)

    // A search query (q) is a genuine recall: stamp the surfaced memories as
    // just-accessed so accessed_at reflects real usage. Plain listing (no q,
    // e.g. the dashboard browsing all memories) is NOT a recall and must not
    // refresh accessed_at -- otherwise every poll would keep everything "fresh"
    // and defeat staleness detection.
    //
    // Span reads are NOT auto-recorded here: fuzzy search results are noisy
    // (many matches, not all actually consumed). Callers that genuinely process
    // a memory -- heartbeats, direct fetches -- call POST /api/memories/read-event
    // explicitly with the ids they actually used.
    if (q && results.length) touchMemoriesAccessed(results.map(m => m.id))

    // Smart context injection (F2): when searching with a known agent, annotate
    // results with is_stale and surface updated-but-unread memories first.
    let staleIdSet = new Set<number>()
    if (q && agentId && results.length) {
      const ids = results.map(m => m.id)
      const db2 = getDb()
      const staleRows = db2.prepare(`
        SELECT m.id FROM memories m
        LEFT JOIN (
          SELECT memory_id, MAX(read_at) AS last_read
          FROM span_reads WHERE agent_id = ?
          GROUP BY memory_id
        ) sr ON sr.memory_id = m.id
        WHERE m.id IN (${ids.map(() => '?').join(',')})
          AND m.updated_at > COALESCE(sr.last_read, 0)
      `).all(agentId, ...ids) as { id: number }[]
      staleIdSet = new Set(staleRows.map(r => r.id))
      // Stale memories float to the top of context -- the agent needs fresh info first.
      results.sort((a, b) => (staleIdSet.has(b.id) ? 1 : 0) - (staleIdSet.has(a.id) ? 1 : 0))
    }

    // is_stale is only included when an agent filter is active (backward-compat:
    // callers without agent context should not see a misleading false value).
    const includeStale = staleIdSet.size > 0 || (q !== '' && agentId !== '')
    const formatted = results.map(m => ({
      ...m,
      embedding: undefined,
      ...(includeStale ? { is_stale: staleIdSet.has(m.id) } : {}),
      created_label: new Date(m.created_at * 1000).toLocaleString('hu-HU', { timeZone: APP_TZ }),
      accessed_label: new Date(m.accessed_at * 1000).toLocaleString('hu-HU', { timeZone: APP_TZ }),
    }))
    jsonMaybeGzip(req, res, formatted)
    return true
  }

  if (path === '/api/memories/import' && method === 'POST') {
    const body = await readBody(req)
    const { agent_id, chunks } = JSON.parse(body.toString()) as { agent_id: string; chunks: string[] }

    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
      json(res, { error: 'No chunks to import' }, 400)
      return true
    }

    const agentId = agent_id || MAIN_AGENT_ID
    const stats = { hot: 0, warm: 0, cold: 0, shared: 0 }
    let imported = 0

    let categorizeModel: string | null = null
    try {
      const ollamaModels = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })
        .then(r => r.json())
        .then((d: any) => (d.models || []).filter((m: any) => !m.name.includes('embed')).map((m: any) => m.name))
        .catch(() => [] as string[])
      categorizeModel = ollamaModels.find((m: string) => m.includes('gemma4')) || ollamaModels[0] || null
    } catch {
      categorizeModel = null
    }

    if (categorizeModel) {
      logger.info({ model: categorizeModel }, 'Migráció: AI kategorizálás modell kiválasztva')
    } else {
      logger.info('Migráció: nincs elérhető Ollama modell, alapértelmezett warm besorolás')
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]

      if (!categorizeModel) {
        saveAgentMemory(agentId, chunk, 'warm', '', true)
        stats.warm++
        imported++
        continue
      }

      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 90000)

        const catResponse = await fetch(`${OLLAMA_URL}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: categorizeModel,
            prompt: `Categorize this memory into exactly one tier and generate keywords.

Memory: "${chunk.slice(0, 500)}"

Tiers:
- hot: active tasks, pending decisions, things happening NOW
- warm: preferences, config, project context, stable knowledge
- cold: long-term lessons, historical decisions, archive
- shared: information relevant to multiple agents

Respond ONLY with JSON, nothing else:
{"tier": "warm", "keywords": "keyword1, keyword2, keyword3"}`,
            stream: false,
          }),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const catData = await catResponse.json() as { response?: string }

        let tier = 'warm'
        let keywords = ''

        try {
          const jsonMatch = (catData.response || '').match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0])
            tier = ['hot', 'warm', 'cold', 'shared'].includes(parsed.tier) ? parsed.tier : 'warm'
            keywords = parsed.keywords || ''
          }
        } catch {
          // Default to warm if parsing fails
        }

        saveAgentMemory(agentId, chunk, tier, keywords, true)
        stats[tier as keyof typeof stats]++
        imported++

        if (i < chunks.length - 1) {
          await new Promise(r => setTimeout(r, 200))
        }
      } catch {
        saveAgentMemory(agentId, chunk, 'warm', '', true)
        stats.warm++
        imported++
      }
    }

    logger.info({ agentId, imported, stats }, 'Migráció befejezve')
    json(res, { ok: true, imported, stats })
    return true
  }

  if (path === '/api/memories/backfill' && method === 'POST') {
    try {
      const count = await backfillEmbeddings()
      json(res, { ok: true, count })
    } catch (err) {
      logger.error({ err }, 'Backfill failed')
      json(res, { error: 'Backfill failed' }, 500)
    }
    return true
  }

  if (path === '/api/memories/stats' && method === 'GET') {
    json(res, getMemoryStats())
    return true
  }

  // POST /api/memories/resort -- scheduled maintenance: tier-resort + version prune.
  // Called daily by the maintenance scheduled task. Idempotent.
  // Body (all optional): { warm_to_cold_days, cold_to_warm_hours, min_agents, version_ttl_days }
  if (path === '/api/memories/resort' && method === 'POST') {
    try {
      const body = await readBody(req)
      const opts = body.length ? JSON.parse(body.toString()) : {}
      const result = runMemoryMaintenance({
        warmToColdDays: opts.warm_to_cold_days,
        coldToWarmHours: opts.cold_to_warm_hours,
        minAgents: opts.min_agents,
        versionTtlDays: opts.version_ttl_days,
      })
      logger.info(result, 'Memory resort + prune complete')
      json(res, { ok: true, ...result })
    } catch (err) {
      logger.error({ err }, 'Memory resort failed')
      json(res, { error: 'Resort failed' }, 500)
    }
    return true
  }

  // POST /api/memories/read-event -- explicit read-trace (heartbeat / direct)
  // Accepts single: {agent_id, memory_id, context}
  // Or batch:       {reads: [{agent_id, memory_id, context}]}
  if (path === '/api/memories/read-event' && method === 'POST') {
    const body = await readBody(req)
    const parsed = JSON.parse(body.toString()) as {
      agent_id?: string; memory_id?: number; context?: string
      reads?: { agent_id: string; memory_id: number; context?: string }[]
    }
    const toCtx = (c?: string): 'heartbeat' | 'search' | 'direct' =>
      (['heartbeat', 'search', 'direct'].includes(c ?? '')) ? c as 'heartbeat' | 'search' | 'direct' : 'direct'

    if (parsed.reads) {
      // Batch mode
      const batchByAgent = new Map<string, { ids: number[]; ctx: 'heartbeat' | 'search' | 'direct' }>()
      for (const r of parsed.reads) {
        if (!r.agent_id || !r.memory_id) continue
        const key = `${r.agent_id}::${toCtx(r.context)}`
        if (!batchByAgent.has(key)) batchByAgent.set(key, { ids: [], ctx: toCtx(r.context) })
        batchByAgent.get(key)!.ids.push(r.memory_id)
      }
      for (const [key, { ids, ctx }] of batchByAgent) {
        const agentId = key.split('::')[0]
        recordMemoryReadBatch(agentId, ids, ctx)
      }
      json(res, { ok: true, recorded: parsed.reads.length })
      return true
    }

    const { agent_id, memory_id, context } = parsed
    if (!agent_id || !memory_id) { json(res, { error: 'agent_id and memory_id required' }, 400); return true }
    recordMemoryRead(agent_id, memory_id, toCtx(context))
    json(res, { ok: true })
    return true
  }

  // GET /api/memories/stale?agent_id=X -- memories updated after agent's last read
  if (path === '/api/memories/stale' && method === 'GET') {
    const agentId = url.searchParams.get('agent_id') || url.searchParams.get('agent') || ''
    if (!agentId) { json(res, { error: 'agent_id required' }, 400); return true }
    const stale = getStaleMemories(agentId)
    json(res, stale.map(m => ({ ...m, embedding: undefined })))
    return true
  }

  // GET /api/memories/:id/versions -- version history for a single memory
  const memVersionsMatch = path.match(/^\/api\/memories\/(\d+)\/versions$/)
  if (memVersionsMatch && method === 'GET') {
    const id = parseInt(memVersionsMatch[1], 10)
    json(res, getMemoryVersions(id))
    return true
  }

  const memIdMatch = path.match(/^\/api\/memories\/(\d+)$/)
  if (memIdMatch && method === 'GET') {
    const id = parseInt(memIdMatch[1], 10)
    const includeVersions = url.searchParams.get('include') === 'versions'
    const db2 = getDb()
    const mem = db2.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | undefined
    if (!mem) { json(res, { error: 'Memory not found' }, 404); return true }
    const { embedding: _emb, ...rest } = mem
    const agentId = url.searchParams.get('agent_id') || url.searchParams.get('agent') || ''
    if (agentId) recordMemoryRead(agentId, id, 'direct')
    const payload: Record<string, unknown> = { ...rest }
    if (includeVersions) payload.versions = getMemoryVersions(id)
    json(res, payload)
    return true
  }

  if (memIdMatch && method === 'PUT') {
    const id = parseInt(memIdMatch[1], 10)
    const body = await readBody(req)
    const { content, category, tier, agent_id, keywords } = JSON.parse(body.toString()) as { content: string; category?: string; tier?: string; agent_id?: string; keywords?: string }
    if (updateMemory(id, content, tier || category, agent_id, keywords)) { json(res, { ok: true }); return true }
    json(res, { error: 'Memory not found' }, 404)
    return true
  }

  if (memIdMatch && method === 'DELETE') {
    const id = parseInt(memIdMatch[1], 10)
    const db2 = getDb()
    const changes = db2.prepare('DELETE FROM memories WHERE id = ?').run(id).changes
    // Invalidate the in-process TTL cache so a deleted memory does not
    // resurface in the agent-filtered list for the cache lifetime.
    if (changes > 0) clearMemoryCache()
    if (changes > 0) { json(res, { ok: true }); return true }
    json(res, { error: 'Memory not found' }, 404)
    return true
  }

  return false
}
