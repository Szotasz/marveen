import {
  saveAgentMemory, getAgentMemories, searchAgentMemories, getMemoryStats, updateMemory,
  hybridSearch, backfillEmbeddings, clearMemoryCache,
  searchMemories, getMemoriesForChat, getDb, touchMemoriesAccessed,
  type Memory,
} from '../../db.js'
import { MAIN_AGENT_ID, ALLOWED_CHAT_ID, OLLAMA_URL, MEMORY_IMPORT_CATEGORIZE_MODEL, APP_TZ } from '../../config.js'
import { logger } from '../../logger.js'
import { readBody, json, jsonMaybeGzip } from '../http-helpers.js'
import { detectHomoglyphs, formatHomoglyphWarning } from '../../homoglyph.js'
import type { HybridSearchTrace } from '../../db.js'
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

export function containsSuspiciousContent(content: string): boolean {
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
    // Warn-only homoglyph check (GATEHOMOGLIFSWEEP816): the save above already
    // happened -- legitimate Cyrillic/Greek content (quotes, foreign records)
    // must never be lost, so the finding rides the response instead of a 4xx.
    const homoglyphs = detectHomoglyphs(data.content)
    if (homoglyphs.length > 0) {
      const warning = formatHomoglyphWarning(homoglyphs)
      logger.warn({ agent: data.agent_id, memoryId: result.id }, `memory saved with ${warning}`)
      json(res, { ok: true, id: result.id, homoglyph_warning: warning })
      return true
    }
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
    // strict=1 is the opt-in for "answer only on a real match". The default
    // stays forgiving, because that is what makes a naturally phrased question
    // find its memory; what the default owes the caller is the LABEL below,
    // not silence.
    const strictOnly = url.searchParams.get('strict') === '1'
    // #947: offset is honoured on the LISTING branches only. A negative or
    // non-numeric value is clamped to 0 (no page skip) rather than erroring --
    // the failure this fixes was a SILENT one, and a hard 400 on a stray value
    // would trade it for a different surprise.
    const offsetRaw = parseInt(url.searchParams.get('offset') || '0', 10)
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0
    // offset makes no sense on a relevance-ranked search: hybridSearch fuses two
    // rankings and searchAgentMemories oversamples FTS then re-ranks in JS, so a
    // SQL OFFSET would page over a DIFFERENT ranking than page 1 returned.
    // Reject the combination loudly instead of dropping offset silently --
    // silently dropping the parameter is the class of bug #947 is about.
    if (offset > 0 && q) {
      json(res, { error: 'offset is not supported together with q (search results are relevance-ranked, not a stable page order)' }, 400)
      return true
    }

    let results: Memory[]
    // GH #1025: a hybrid answer built entirely by the vector branch looks the
    // same as one with lexical support. The trace rides the response so the
    // caller can tell them apart.
    const hybridTrace: HybridSearchTrace = { ftsHits: 0, vectorHits: 0, ftsRelaxed: false, vectorOnly: false }
    const searchTrace: { relaxed: boolean } = { relaxed: false }
    // MEMKERESVAK917: `tier` goes INTO the search, not on top of its answer.
    // It used to be a post-filter applied after the search had already cut to
    // `limit`, which meant a filtered search truncated silently -- and said
    // relaxed=false while doing it. Every search branch below takes it now.
    const searchCategory = tier || undefined
    if (q && mode === 'hybrid') {
      results = await hybridSearch(agentId || MAIN_AGENT_ID, q, limit, hybridTrace, searchCategory)
    } else if (q && agentId) {
      results = searchAgentMemories(agentId, q, limit, searchTrace, !strictOnly, searchCategory)
      if (results.length === 0) {
        // Substring fallback. It is NOT a second relaxation: LIKE %q% still
        // requires the query to appear literally, so a query that matches
        // nothing still returns nothing.
        const db2 = getDb()
        results = (searchCategory
          ? db2.prepare("SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND category = ? AND (content LIKE ? OR keywords LIKE ?) ORDER BY accessed_at DESC LIMIT ?")
              .all(agentId, searchCategory, `%${q}%`, `%${q}%`, limit)
          : db2.prepare("SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? OR keywords LIKE ?) ORDER BY accessed_at DESC LIMIT ?")
              .all(agentId, `%${q}%`, `%${q}%`, limit)) as Memory[]
      }
    } else if (q) {
      results = searchMemories(q, ALLOWED_CHAT_ID, limit, !strictOnly, searchCategory)
      if (results.length === 0) {
        const db2 = getDb()
        results = (searchCategory
          ? db2.prepare('SELECT * FROM memories WHERE content LIKE ? AND category = ? ORDER BY accessed_at DESC LIMIT ?').all(`%${q}%`, searchCategory, limit)
          : db2.prepare('SELECT * FROM memories WHERE content LIKE ? ORDER BY accessed_at DESC LIMIT ?').all(`%${q}%`, limit)) as Memory[]
      }
    } else if (agentId) {
      // Category goes into the query, not a post-filter: see getAgentMemories.
      results = getAgentMemories(agentId, limit, tier || undefined, offset)
    } else {
      results = getMemoriesForChat(ALLOWED_CHAT_ID, limit, offset)
    }

    // Kept as a backstop, not as the mechanism. Since MEMKERESVAK917 every
    // branch above filters in SQL, so this is a no-op on a correct answer --
    // and the one thing that would still catch a branch added later that
    // forgets to take searchCategory.
    if (tier) results = results.filter(m => m.category === tier)

    // A search query (q) is a genuine recall: stamp the surfaced memories as
    // just-accessed so accessed_at reflects real usage. Plain listing (no q,
    // e.g. the dashboard browsing all memories) is NOT a recall and must not
    // refresh accessed_at -- otherwise every poll would keep everything "fresh"
    // and defeat staleness detection.
    if (q && results.length) touchMemoriesAccessed(results.map(m => m.id))

    const formatted = results.map(m => ({
      ...m,
      embedding: undefined,
      created_label: new Date(m.created_at * 1000).toLocaleString('hu-HU', { timeZone: APP_TZ }),
      accessed_label: new Date(m.accessed_at * 1000).toLocaleString('hu-HU', { timeZone: APP_TZ }),
    }))
    // The body of this endpoint is a bare array and several callers index into
    // it, so the trace rides a header rather than changing the shape.
    if (q && mode === 'hybrid') {
      res.setHeader(
        'X-Memory-Search',
        `fts=${hybridTrace.ftsHits}; vector=${hybridTrace.vectorHits};` +
          ` relaxed=${hybridTrace.ftsRelaxed}; vector-only=${hybridTrace.vectorOnly}`,
      )
    } else if (q) {
      // The label the endpoint owed its callers. `relaxed=true` means no row
      // matched the query as asked and these are the rescued near-misses, so a
      // caller answering "do we have anything on this" can tell the two apart
      // without asking twice. `strict=true` says the caller demanded a real
      // match, and an empty body then means exactly what it looks like.
      res.setHeader('X-Memory-Search', `strict=${strictOnly}; relaxed=${searchTrace.relaxed}; hits=${results.length}`)
    } else {
      // The listing branches owe a label too. Without one the caller cannot
      // tell "this endpoint does not label its answers" from "this answer was
      // not relaxed" -- the header's ABSENCE reads like the search header's
      // absence did before it existed, which is the silence this label was
      // introduced to end. There was no query here, so relaxation cannot
      // apply and saying `relaxed=false` would imply a match that was never
      // asked for; the honest statement is that this is a listing.
      // `truncated` is the one thing a listing can silently lose: at hits ===
      // limit there may be more rows behind the cut, and a caller reading the
      // body alone cannot see that.
      res.setHeader(
        'X-Memory-Search',
        `listing=true; hits=${results.length}; truncated=${results.length >= limit}`,
      )
    }
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

    // The model is never GUESSED -- and the feature is never silently switched
    // off either. Two rules, in this order:
    //
    //   1. MEMORY_IMPORT_CATEGORIZE_MODEL is an OVERRIDE, not a switch: when
    //      set, exactly that model runs (a bare name matches its `:latest`
    //      tag). If it is not installed, nothing is substituted -- warm, and a
    //      warning that names the missing model.
    //   2. With nothing set, `gemma4*` is auto-detected: the intended model,
    //      named in this code since the feature shipped. A correctly
    //      provisioned host keeps categorizing with no configuration at all.
    //
    // What is gone is the old `?? installed[0]` fallback. On a host WITHOUT
    // gemma4 it picked whatever Ollama happened to list first; measured on a
    // 4 GB host that was deepseek-coder:1.3b, which scored 4/12 on a
    // hand-labelled set -- exactly what tagging everything warm scores --
    // returned unparseable output half the time and held the GPU ~8s per
    // chunk. No categorization is better than that; a wrong tier is worse than
    // an honest default.
    //
    // Embedding models are excluded from the auto-detect on purpose: they
    // cannot answer /api/generate at all, so matching one would be a silent
    // no-op dressed up as a working categorizer.
    let categorizeModel: string | null = null
    const wanted = MEMORY_IMPORT_CATEGORIZE_MODEL
    const installed = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.json())
      .then((d: any) => (d.models || []).map((m: any) => m.name) as string[])
      .catch(() => [] as string[])
    if (wanted) {
      const tagged = wanted.includes(':') ? wanted : `${wanted}:latest`
      categorizeModel = installed.find(m => m === wanted || m === tagged) ?? null
      if (categorizeModel) {
        logger.info({ model: categorizeModel }, 'Migráció: AI kategorizálás modell kiválasztva (beállítás)')
      } else {
        logger.warn({ model: wanted, ollamaUrl: OLLAMA_URL }, 'Migráció: a beállított kategorizáló modell nem elérhető, alapértelmezett warm besorolás')
      }
    } else {
      categorizeModel = installed.find(m => /^gemma4(?:[:\-]|$)/.test(m) && !m.includes('embed')) ?? null
      if (categorizeModel) {
        logger.info({ model: categorizeModel }, 'Migráció: AI kategorizálás modell felismerve (gemma4)')
      } else {
        logger.info({ ollamaUrl: OLLAMA_URL }, 'Migráció: nincs telepített gemma4 és nincs MEMORY_IMPORT_CATEGORIZE_MODEL, alapértelmezett warm besorolás')
      }
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

  const memUpdateMatch = path.match(/^\/api\/memories\/(\d+)$/)
  if (memUpdateMatch && (method === 'PUT' || method === 'PATCH')) {
    const id = parseInt(memUpdateMatch[1], 10)
    const body = await readBody(req)
    // MEMIRASNYOM915: updated_by is the writer's self-reported identity for
    // the write-trace. It is distinct from agent_id, which means "reassign
    // the row to this agent" -- an editor updating someone else's memory
    // attributes the WRITE without changing the OWNER.
    const { content, category, tier, agent_id, keywords, updated_by } = JSON.parse(body.toString()) as { content?: string; category?: string; tier?: string; agent_id?: string; keywords?: string; updated_by?: string }
    const newCategory = (tier || category || '').toLowerCase() || undefined
    if (newCategory && !MEMORY_CATEGORIES.has(newCategory)) {
      json(res, { error: `Invalid category "${newCategory}". Allowed: ${[...MEMORY_CATEGORIES].join(', ')}` }, 400)
      return true
    }
    // Partial update: a category-only change (the hot->cold tier move) must not
    // require re-sending the content. updateMemory() always SETs content, so an
    // omitted content is backfilled from the existing row -- previously an
    // undefined content made the SQL bind throw and the endpoint 500'd, which
    // left tier moves impossible via the API (Dream Engine blocker, 2026-07-30).
    let effectiveContent = content
    if (effectiveContent === undefined) {
      const row = getDb().prepare('SELECT content FROM memories WHERE id = ?').get(id) as { content: string } | undefined
      if (!row) { json(res, { error: 'Memory not found' }, 404); return true }
      effectiveContent = row.content
    } else if (containsSuspiciousContent(effectiveContent)) {
      json(res, { error: 'Content rejected by security filter' }, 400)
      return true
    }
    if (updateMemory(id, effectiveContent, newCategory, agent_id, keywords, updated_by)) { json(res, { ok: true }); return true }
    json(res, { error: 'Memory not found' }, 404)
    return true
  }

  if (memUpdateMatch && method === 'DELETE') {
    const id = parseInt(memUpdateMatch[1], 10)
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
