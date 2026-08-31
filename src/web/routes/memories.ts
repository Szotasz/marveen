import {
  saveAgentMemory, getAgentMemories, searchAgentMemories, getMemoryStats, updateMemory,
  hybridSearch, backfillEmbeddings, clearMemoryCache,
  searchMemories, getMemoriesForChat, getDb, touchMemoriesAccessed,
  recordMemoryRead, recordMemoryReadBatch, getStaleMemories, getMemoryVersions,
  runMemoryMaintenance, runLinkMaintenance, getLinksForMemories, writeAgentAuditLog,
  syncVecMemoryDelete,
  type Memory,
} from '../../db.js'
import { MAIN_AGENT_ID, ALLOWED_CHAT_ID, OLLAMA_URL, APP_TZ } from '../../config.js'
import { logger } from '../../logger.js'
import { readBody, json, jsonMaybeGzip } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Canonical memory categories. Kept in sync with the DB CHECK constraint in
// src/db.ts so the API rejects bad values before they even reach SQLite.
const MEMORY_CATEGORIES = new Set(['hot', 'warm', 'cold', 'shared'])

// Prompt-injection guard: reject memory content that attempts to override the
// agent's instructions. Technical shell/code patterns (curl, rm -rf, eval, etc.)
// are intentionally NOT included: stored text cannot execute itself, and blocking
// those patterns prevents legitimate incident-notes and skill-recipes from being
// saved (false-positive class discovered 2026-08-29).
const SUSPICIOUS_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /override\s+your\s+(instructions|rules|safety|guidelines)/i,
  /forget\s+your\s+(instructions|rules|safety|guidelines|training)/i,
  /new\s+persona/i,
]

function containsSuspiciousContent(content: string): boolean {
  return SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(content))
}

export async function tryHandleMemories(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // Tenant scope: admin role sees/writes all tenants (bypass); scoped callers
  // are restricted to their own tenant_id. The 'default' tenant covers the
  // fleet's own memories for backward-compat (existing rows + fleet agents).
  // Global admins may pass ?tenant=<id> to narrow to one specific tenant.
  const isAdmin = ctx.role === 'admin'
  const tenantParam = isAdmin ? (url.searchParams.get('tenant') ?? null) : null
  const effectiveTenantId: string = tenantParam ?? (isAdmin ? 'default' : (ctx.tenantId ?? 'default'))

  if (path === '/api/memories' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { agent_id?: string; content: string; tier?: string; category?: string; keywords?: string }
    if (!data.content?.trim()) { json(res, { error: 'required', field: 'content', hint: 'Content is required' }, 400); return true }
    if (containsSuspiciousContent(data.content)) {
      logger.warn({ agent: data.agent_id }, 'Memory content rejected: suspicious pattern')
      json(res, { error: 'forbidden', hint: 'Content rejected by security filter' }, 403)
      return true
    }
    if (data.tier && !data.category) {
      logger.warn({ agent: data.agent_id }, '[DEPRECATED] /api/memories: use "category" instead of "tier"')
    }
    const category = (data.category || data.tier || 'warm').toLowerCase()
    if (!MEMORY_CATEGORIES.has(category)) {
      json(res, { error: 'invalid_value', field: 'category', hint: `Invalid category "${category}". Allowed: ${[...MEMORY_CATEGORIES].join(', ')}` }, 400)
      return true
    }
    const result = saveAgentMemory(
      data.agent_id || MAIN_AGENT_ID,
      data.content.trim(),
      category,
      data.keywords || undefined,
      true,
      effectiveTenantId,
    )
    try {
      if (ctx.auth?.kind === 'session' && ctx.auth.user) {
        writeAgentAuditLog({ agent_id: ctx.auth.user, entity: 'memory', action: 'create', entity_id: result.id })
      }
    } catch { /* audit failure must not abort the save */ }
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
    const mode = url.searchParams.get('mode') || 'hybrid'

    let results: Memory[]
    const recallTenantId = isAdmin ? (tenantParam ?? undefined) : effectiveTenantId
    if (q && mode === 'hybrid') {
      results = await hybridSearch(agentId || MAIN_AGENT_ID, q, limit, recallTenantId)
    } else if (q && agentId) {
      results = searchAgentMemories(agentId, q, limit, recallTenantId)
      if (results.length === 0) {
        const db2 = getDb()
        const tcFallback = recallTenantId ? ' AND tenant_id = ?' : ''
        const tpFallback = recallTenantId ? [recallTenantId] : []
        results = db2.prepare(`SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? OR keywords LIKE ?)${tcFallback} ORDER BY accessed_at DESC LIMIT ?`)
          .all(agentId, `%${q}%`, `%${q}%`, ...tpFallback, limit) as Memory[]
      }
    } else if (q) {
      results = searchMemories(q, ALLOWED_CHAT_ID, limit, recallTenantId)
      if (results.length === 0) {
        const db2 = getDb()
        const tcFallback = recallTenantId ? ' AND tenant_id = ?' : ''
        const tpFallback = recallTenantId ? [recallTenantId] : []
        results = db2.prepare(`SELECT * FROM memories WHERE content LIKE ?${tcFallback} ORDER BY accessed_at DESC LIMIT ?`)
          .all(`%${q}%`, ...tpFallback, limit) as Memory[]
      }
    } else if (agentId) {
      // Tenant filtering pushed into SQL (before LIMIT) to avoid the post-filter
      // accuracy bug: getAgentMemories enforces tenantId in the WHERE clause.
      results = getAgentMemories(agentId, limit, tier || undefined, recallTenantId)
    } else {
      results = getMemoriesForChat(ALLOWED_CHAT_ID, limit, recallTenantId)
    }

    // Tenant isolation: defence-in-depth guard. All branches above now filter
    // tenant_id in SQL before LIMIT, so this filter is redundant in the normal
    // path. It stays as a safety net in case a future branch forgets SQL-level
    // filtering -- a non-admin caller must never see another tenant's rows.
    if (!isAdmin) {
      results = results.filter((m) => ((m as Memory & { tenant_id?: string }).tenant_id ?? 'default') === effectiveTenantId)
    }

    // Still needed for the search branches above, which rank by relevance and
    // cannot push the category down into their own LIMIT. A no-op for the
    // plain agent listing, which already filtered in SQL.
    if (tier && tier !== 'import') results = results.filter(m => m.category === tier)
    else if (tier === 'import') results = results.filter(m => m.agent_id === 'import')

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
      embedding_blob: undefined,
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
      json(res, { error: 'required', field: 'chunks', hint: 'No chunks to import' }, 400)
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
      json(res, { error: 'internal_error', hint: 'Backfill failed' }, 500)
    }
    return true
  }

  if (path === '/api/memories/stats' && method === 'GET') {
    json(res, getMemoryStats())
    return true
  }

  // POST /api/memories/resort -- scheduled maintenance: tier-resort + version prune.
  // Called daily by the maintenance scheduled task. Idempotent.
  // Body (all optional): { warm_to_cold_days, cold_to_warm_days, min_agents, version_ttl_days }
  if (path === '/api/memories/resort' && method === 'POST') {
    try {
      const body = await readBody(req)
      const opts = body.length ? JSON.parse(body.toString()) : {}
      const result = runMemoryMaintenance({
        warmToColdDays: opts.warm_to_cold_days,
        coldToWarmDays: opts.cold_to_warm_days,
        minAgents: opts.min_agents,
        versionTtlDays: opts.version_ttl_days,
      })
      logger.info(result, 'Memory resort + prune complete')
      json(res, { ok: true, ...result })
    } catch (err) {
      logger.error({ err }, 'Memory resort failed')
      json(res, { error: 'internal_error', hint: 'Resort failed' }, 500)
    }
    return true
  }

  // GET /api/memories/links -- fetch memory_links edges for a set of memory ids.
  // Query params: ids (comma-separated) OR agent (fetch all links for agent's memories).
  // Returns [{src_id, dst_id, link_type, weight}] -- used by the dashboard graph.
  if (path === '/api/memories/links' && method === 'GET') {
    const idsParam = url.searchParams.get('ids')
    const agentParam = url.searchParams.get('agent')
    let memoryIds: number[] = []
    if (idsParam) {
      memoryIds = idsParam.split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n))
    } else if (agentParam) {
      const rows = getDb().prepare(
        `SELECT id FROM memories WHERE agent_id = ? ORDER BY accessed_at DESC LIMIT 500`
      ).all(agentParam) as { id: number }[]
      memoryIds = rows.map(r => r.id)
    }
    json(res, getLinksForMemories(memoryIds))
    return true
  }

  // POST /api/memories/links/maintain -- link-graph maintenance heartbeat.
  // Re-embeds stale memories, refreshes neighbor links, prunes decayed edges,
  // and counts orphan memories. Called by the memory-maintenance scheduled task.
  // Body (all optional): { weight_threshold, max_age_seconds }
  if (path === '/api/memories/links/maintain' && method === 'POST') {
    try {
      const body = await readBody(req)
      const opts = body.length ? JSON.parse(body.toString()) : {}
      const result = await runLinkMaintenance({
        weightThreshold: opts.weight_threshold,
        maxAge: opts.max_age_seconds,
      })
      json(res, { ok: true, ...result })
    } catch (err) {
      logger.error({ err }, 'Link maintenance failed')
      json(res, { error: 'internal_error', hint: 'Link maintenance failed' }, 500)
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
    if (!agent_id || !memory_id) { json(res, { error: 'required', hint: 'agent_id and memory_id required' }, 400); return true }
    recordMemoryRead(agent_id, memory_id, toCtx(context))
    json(res, { ok: true })
    return true
  }

  // GET /api/memories/graph -- single-round-trip graph payload for the dashboard graph.
  // Edges only include pairs where BOTH endpoints are in the nodes array (AND, not OR).
  // Query params: agent?, weight_min (default 0.75), limit (default 200, max 500).
  // GET /api/memories/graph/timeline -- temporal graph slice for the timeline scrubber.
  // Returns nodes + edges in a time window, plus a flat event list built from node
  // created_at ('created'), memory_links created_at ('linked'), and memory_versions
  // category_change entries ('tier_changed').
  if (path === '/api/memories/graph/timeline' && method === 'GET') {
    const agentParam  = url.searchParams.get('agent') || ''
    const weightMin   = Math.max(0, Math.min(1, parseFloat(url.searchParams.get('weight_min') || '0.75')))
    const nowSec      = Math.floor(Date.now() / 1000)
    const fromTs      = parseInt(url.searchParams.get('from') || '0', 10)
    const toTs        = Math.min(nowSec, parseInt(url.searchParams.get('to') || String(nowSec), 10))

    if (fromTs > toTs) { json(res, { error: 'invalid_value', field: 'from', hint: 'from must be <= to' }, 400); return true }

    const db2 = getDb()

    // Nodes created within the requested window (agent-filtered if provided)
    const nodeRows: Memory[] = agentParam
      ? db2.prepare(
          `SELECT id, content, agent_id, category, created_at, accessed_at
           FROM memories
           WHERE agent_id = ? AND created_at >= ? AND created_at <= ?
           ORDER BY created_at ASC`
        ).all(agentParam, fromTs, toTs) as Memory[]
      : db2.prepare(
          `SELECT id, content, agent_id, category, created_at, accessed_at
           FROM memories
           WHERE created_at >= ? AND created_at <= ?
           ORDER BY created_at ASC`
        ).all(fromTs, toTs) as Memory[]

    const nodeIdSet    = new Set(nodeRows.map(r => r.id))
    const placeholders = nodeRows.map(() => '?').join(',')

    // Edges where both endpoints are in the node set AND weight >= weight_min.
    // created_at filter not applied on edges: an edge may be created outside the
    // window if both nodes happen to fall inside it.
    type LinkRow = { src_id: number; dst_id: number; weight: number; created_at: number }
    const edgeRows: LinkRow[] = nodeRows.length > 0
      ? (db2.prepare(
          `SELECT src_id, dst_id, weight, created_at FROM memory_links
           WHERE src_id IN (${placeholders}) AND dst_id IN (${placeholders})
             AND weight >= ?`
        ).all(...nodeRows.map(r => r.id), ...nodeRows.map(r => r.id), weightMin) as LinkRow[])
          .filter(e => nodeIdSet.has(e.src_id) && nodeIdSet.has(e.dst_id))
      : []

    // Degree map (same weight threshold)
    type DegreeRow = { src_id: number; degree: number }
    const degreeMap = new Map<number, number>()
    if (nodeRows.length > 0) {
      const degRows = db2.prepare(
        `SELECT src_id, COUNT(*) AS degree FROM memory_links
         WHERE src_id IN (${placeholders}) AND weight >= ?
         GROUP BY src_id`
      ).all(...nodeRows.map(r => r.id), weightMin) as DegreeRow[]
      for (const d of degRows) degreeMap.set(d.src_id, d.degree)
    }

    const nodes = nodeRows.map(r => ({
      id:          r.id,
      label:       r.content.length > 40 ? r.content.slice(0, 40) + '...' : r.content,
      tier:        r.agent_id === 'import' ? 'import' : (r.category || 'warm'),
      agent:       r.agent_id || '',
      degree:      degreeMap.get(r.id) ?? 0,
      created_at:  r.created_at,
      accessed_at: r.accessed_at,
    }))

    // Tier-change events: memory_versions entries with change_type='category_change'
    // whose changed_at falls in the window and whose memory_id is in the node set.
    // from_tier is derived by inverting to_tier (maintenance only does warm<->cold).
    type TierChangeRow = { memory_id: number; changed_at: number; category: string }
    const tierChangedRows: TierChangeRow[] = nodeRows.length > 0
      ? (db2.prepare(
          `SELECT mv.memory_id, mv.changed_at, mv.category
           FROM memory_versions mv
           WHERE mv.change_type = 'category_change'
             AND mv.changed_at >= ? AND mv.changed_at <= ?
             AND mv.memory_id IN (${placeholders})`
        ).all(fromTs, toTs, ...nodeRows.map(r => r.id)) as TierChangeRow[])
      : []

    // Event list: 'created' per node + 'linked' per edge + 'tier_changed' per version entry.
    // Sorted by ts ascending for the frontend scrubber.
    type TimelineEvent = {
      memory_id: number
      type: 'created' | 'linked' | 'tier_changed'
      ts: number
      from_tier?: string
      to_tier?: string
    }
    const events: TimelineEvent[] = [
      ...nodeRows.map(r => ({ memory_id: r.id, type: 'created' as const, ts: r.created_at })),
      ...edgeRows.map(e => ({ memory_id: e.src_id, type: 'linked' as const, ts: e.created_at })),
      ...tierChangedRows.map(r => ({
        memory_id: r.memory_id,
        type: 'tier_changed' as const,
        ts: r.changed_at,
        from_tier: r.category === 'cold' ? 'warm' : 'cold',
        to_tier: r.category,
      })),
    ].sort((a, b) => a.ts - b.ts)

    // Remove the old comment marker now that the audit log exists
    // (was: "tier_changed is omitted (no audit-log exists)")

    const allTs = nodeRows.map(r => r.created_at)
    json(res, {
      nodes,
      edges: edgeRows,
      events,
      time_range: {
        min_ts: allTs.length > 0 ? Math.min(...allTs) : fromTs,
        max_ts: allTs.length > 0 ? Math.max(...allTs) : toTs,
      },
    })
    return true
  }

  if (path === '/api/memories/graph' && method === 'GET') {
    const agentParam = url.searchParams.get('agent') || ''
    const weightMin = Math.max(0, Math.min(1, parseFloat(url.searchParams.get('weight_min') || '0.75')))
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10)))
    const db2 = getDb()

    const nodeRows = agentParam
      ? db2.prepare(
          `SELECT id, content, agent_id, category, created_at, accessed_at
           FROM memories WHERE agent_id = ? ORDER BY accessed_at DESC LIMIT ?`
        ).all(agentParam, limit) as Memory[]
      : db2.prepare(
          `SELECT id, content, agent_id, category, created_at, accessed_at
           FROM memories ORDER BY accessed_at DESC LIMIT ?`
        ).all(limit) as Memory[]

    const nodeIdSet = new Set(nodeRows.map(r => r.id))
    const placeholders = nodeRows.map(() => '?').join(',')

    type LinkRow = { src_id: number; dst_id: number; weight: number; created_at: number }
    const edgeRows: LinkRow[] = nodeRows.length > 0
      ? (db2.prepare(
          `SELECT src_id, dst_id, weight, created_at FROM memory_links
           WHERE src_id IN (${placeholders}) AND dst_id IN (${placeholders}) AND weight >= ?`
        ).all(...nodeRows.map(r => r.id), ...nodeRows.map(r => r.id), weightMin) as LinkRow[])
          .filter(e => nodeIdSet.has(e.src_id) && nodeIdSet.has(e.dst_id))
      : []

    type DegreeRow = { src_id: number; degree: number }
    const degreeMap = new Map<number, number>()
    if (nodeRows.length > 0) {
      const degRows = db2.prepare(
        `SELECT src_id, COUNT(*) AS degree FROM memory_links
         WHERE src_id IN (${placeholders}) AND weight >= ?
         GROUP BY src_id`
      ).all(...nodeRows.map(r => r.id), weightMin) as DegreeRow[]
      for (const d of degRows) degreeMap.set(d.src_id, d.degree)
    }

    const orphanCount = nodeRows.filter(r => !edgeRows.some(e => e.src_id === r.id || e.dst_id === r.id)).length

    const nodes = nodeRows.map(r => ({
      id: r.id,
      label: r.content.length > 40 ? r.content.slice(0, 40) + '...' : r.content,
      tier: r.agent_id === 'import' ? 'import' : (r.category || 'warm'),
      agent: r.agent_id || '',
      degree: degreeMap.get(r.id) ?? 0,
      created_at: r.created_at,
      accessed_at: r.accessed_at,
    }))

    json(res, {
      nodes,
      edges: edgeRows,
      meta: {
        total_memories: nodeRows.length,
        orphan_count: orphanCount,
        fetched_at: Math.floor(Date.now() / 1000),
      },
    })
    return true
  }

  // GET /api/memories/stale?agent_id=X -- memories updated after agent's last read
  if (path === '/api/memories/stale' && method === 'GET') {
    const agentId = url.searchParams.get('agent_id') || url.searchParams.get('agent') || ''
    if (!agentId) { json(res, { error: 'required', field: 'agent_id', hint: 'agent_id required' }, 400); return true }
    const stale = getStaleMemories(agentId, isAdmin ? undefined : effectiveTenantId)
    json(res, stale.map(m => ({ ...m, embedding: undefined, embedding_blob: undefined })))
    return true
  }

  // GET /api/memories/:id/versions -- version history for a single memory
  const memVersionsMatch = path.match(/^\/api\/memories\/(\d+)\/versions$/)
  if (memVersionsMatch && method === 'GET') {
    const id = parseInt(memVersionsMatch[1], 10)
    json(res, getMemoryVersions(id))
    return true
  }

  // GET /api/memories/:id/detail -- base data + read_count + neighbors + tier history
  const memDetailMatch = path.match(/^\/api\/memories\/(\d+)\/detail$/)
  if (memDetailMatch && method === 'GET') {
    const id = parseInt(memDetailMatch[1], 10)
    const db2 = getDb()

    type DetailRow = { id: number; content: string; category: string; agent_id: string; keywords: string | null; created_at: number; accessed_at: number }
    const mem = db2.prepare(
      'SELECT id, content, category, agent_id, keywords, created_at, accessed_at FROM memories WHERE id = ?'
    ).get(id) as DetailRow | undefined
    if (!mem) { json(res, { error: 'not_found' }, 404); return true }

    type CountRow = { cnt: number }
    const { cnt: read_count } = db2.prepare(
      'SELECT COUNT(*) AS cnt FROM span_reads WHERE memory_id = ?'
    ).get(id) as CountRow

    type NeighborRow = { id: number; content: string; category: string; agent_id: string | null; weight: number; direction: string }
    // SQLite forbids ORDER BY/LIMIT inside individual UNION ALL arms -- wrap each arm in a subquery
    const neighbors = db2.prepare(`
      SELECT * FROM (
        SELECT m.id, m.content, m.category, m.agent_id, ml.weight, 'outgoing' AS direction
        FROM memory_links ml
        JOIN memories m ON m.id = ml.dst_id
        WHERE ml.src_id = ? AND ml.weight >= 0.75
        ORDER BY ml.weight DESC LIMIT 5
      )
      UNION ALL
      SELECT * FROM (
        SELECT m.id, m.content, m.category, m.agent_id, ml.weight, 'incoming' AS direction
        FROM memory_links ml
        JOIN memories m ON m.id = ml.src_id
        WHERE ml.dst_id = ? AND ml.weight >= 0.75
        ORDER BY ml.weight DESC LIMIT 5
      )
    `).all(id, id) as NeighborRow[]

    type VersionRow = { category: string; changed_at: number; changed_by: string }
    const versionRows = db2.prepare(
      `SELECT category, changed_at, changed_by
       FROM memory_versions
       WHERE memory_id = ? AND change_type = 'category_change'
       ORDER BY changed_at ASC`
    ).all(id) as VersionRow[]

    const tier_history = versionRows.map((row, i) => {
      const to_tier = row.category
      const from_tier = i > 0 ? versionRows[i - 1].category : (to_tier === 'cold' ? 'warm' : 'cold')
      return { from_tier, to_tier, changed_at: row.changed_at, changed_by: row.changed_by }
    })

    // For shadow rows (agent_id='import'), look up the originating file and source.
    type ImportMetaRow = { file_name: string; file_path: string; source_label: string | null }
    const import_meta: ImportMetaRow | null = mem.agent_id === 'import'
      ? (db2.prepare(`
          SELECT im.file_name, im.file_path,
                 COALESCE(is_.label, is_.path) AS source_label
          FROM import_memories im
          LEFT JOIN import_sources is_ ON is_.id = im.source_id
          WHERE im.memory_shadow_id = ?
        `).get(id) as ImportMetaRow | null)
      : null

    json(res, {
      id: mem.id,
      // Import shadow rows can be very large (full HTML files); the frontend
      // shows import_meta instead of content, so omit content from the wire.
      content: mem.agent_id === 'import' ? null : mem.content,
      category: mem.category,
      agent_id: mem.agent_id,
      keywords: mem.keywords,
      created_at: mem.created_at,
      accessed_at: mem.accessed_at,
      read_count,
      neighbors: neighbors.map(n => ({
        id: n.id,
        label: n.content.length > 60 ? n.content.slice(0, 60) + '...' : n.content,
        tier: n.agent_id === 'import' ? 'import' : n.category,
        weight: n.weight,
        direction: n.direction,
      })),
      tier_history,
      import_meta,
    })
    return true
  }

  const memIdMatch = path.match(/^\/api\/memories\/(\d+)$/)
  if (memIdMatch && method === 'GET') {
    const id = parseInt(memIdMatch[1], 10)
    const includeVersions = url.searchParams.get('include') === 'versions'
    const db2 = getDb()
    const mem = db2.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | undefined
    if (!mem) { json(res, { error: 'not_found' }, 404); return true }
    const { embedding: _emb, embedding_blob: _blob, ...rest } = mem
    const agentId = url.searchParams.get('agent_id') || url.searchParams.get('agent') || ''
    if (agentId) recordMemoryRead(agentId, id, 'direct')
    const payload: Record<string, unknown> = { ...rest }
    if (includeVersions) payload.versions = getMemoryVersions(id)
    json(res, payload)
    return true
  }

  if (memIdMatch && method === 'PUT') {
    const id = parseInt(memIdMatch[1], 10)
    // Non-admin callers may only update memories belonging to their own tenant.
    if (!isAdmin) {
      const tenantRow = getDb().prepare('SELECT tenant_id FROM memories WHERE id = ?').get(id) as { tenant_id: string } | undefined
      if (!tenantRow || tenantRow.tenant_id !== effectiveTenantId) {
        json(res, { error: 'not_found' }, 404)
        return true
      }
    }
    const body = await readBody(req)
    let parsed: { content: string; category?: string; tier?: string; agent_id?: string; keywords?: string }
    try {
      parsed = JSON.parse(body.toString())
    } catch {
      json(res, { error: 'parse_error', hint: 'Request body is not valid JSON' }, 400)
      return true
    }
    const { content, category, tier, agent_id, keywords } = parsed
    if (typeof content !== 'string' || content.trim() === '') {
      json(res, { error: 'required', field: 'content', hint: 'content is required and must be a non-empty string' }, 400)
      return true
    }
    if (updateMemory(id, content, tier || category, agent_id, keywords)) { json(res, { ok: true }); return true }
    json(res, { error: 'not_found' }, 404)
    return true
  }

  if (memIdMatch && method === 'DELETE') {
    const id = parseInt(memIdMatch[1], 10)
    const db2 = getDb()
    const row = db2.prepare('SELECT agent_id, tenant_id FROM memories WHERE id = ?').get(id) as { agent_id: string | null; tenant_id: string } | undefined
    // Non-admin callers may only delete memories belonging to their own tenant.
    if (!isAdmin && row && row.tenant_id !== effectiveTenantId) {
      json(res, { error: 'not_found' }, 404)
      return true
    }
    const changes = db2.prepare('DELETE FROM memories WHERE id = ?').run(id).changes
    // Invalidate the in-process TTL cache so a deleted memory does not
    // resurface in the agent-filtered list for the cache lifetime.
    if (changes > 0) {
      syncVecMemoryDelete(id)
      clearMemoryCache()
      try {
        writeAgentAuditLog({ agent_id: row?.agent_id || 'unknown', entity: 'memory', action: 'delete', entity_id: id })
      } catch { /* audit failure must not abort the delete */ }
      json(res, { ok: true })
      return true
    }
    json(res, { error: 'not_found' }, 404)
    return true
  }

  return false
}
