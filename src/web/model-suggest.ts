// Pure, side-effect-free persona→model classifier. Imported by the route and
// by unit tests. No fs, no network, no db -- all I/O happens in the caller.

export type ModelId =
  | 'claude-haiku-4-5-20251001'
  | 'claude-sonnet-4-6'
  | 'claude-opus-4-8[1m]'
  | 'claude-fable-5'
  | string

export interface ModelSuggestion {
  suggestedModel: ModelId
  reason: string
  changeAdvised: boolean
}

export interface AgentSuggestionResult {
  agent: string
  currentModel: ModelId
  suggestedModel: ModelId
  reason: string
  changeAdvised: boolean
}

/**
 * Runtime signals collected by the route layer (I/O-free here).
 * Every field is optional so the classifier degrades gracefully when
 * an agent has no history yet.
 */
export interface AgentSignals {
  /** token_usage, last 30 days: totalInput / totalCalls */
  tokenAvgInputPerCall?: number
  /** kanban_cards WHERE assignee=name AND archived_at IS NULL */
  kanbanOpenCount?: number
  /** subset of kanbanOpenCount where priority IN ('urgent','high') */
  kanbanUrgentCount?: number
  /** estimated scheduled-task executions per day (cron-derived) */
  scheduledFreqPerDay?: number
  /** .mcp.json mcpServers key count */
  mcpServerCount?: number
}

// Keyword sets keyed by suggested model tier.
// Match against lowercased persona text (CLAUDE.md + SOUL.md concatenated).
const OPUS_KEYWORDS = [
  'architekt', 'architecture', 'architect',
  'rendszerterv', 'system design', 'elosztott', 'distributed',
  'mikroszolgáltatás', 'microservice',
  'komplex', 'complex', 'összetett',
  'koordinál', 'orchestrat', 'stratégi',
  'dönt', 'decision', 'vezető', 'leader',
  'multi.step', 'agentic', 'multi-agent',
  'senior',
]

const HAIKU_KEYWORDS = [
  'sport', 'edzés', 'edző', 'fitness', 'tréner', 'trainer',
  'futás', 'kerékpár', 'úszás', 'atlétika', 'zwift', 'garmin',
  'számvitel', 'könyvelés', 'könyvelő', 'pénzügyi adminisztráció',
  'accounting', 'bookkeeping',
  'rövid válasz', 'tömör', 'egyszerű feladat',
]

// Approximate input-token cost in USD per 1M tokens (mid-2026 pricing).
const MODEL_COST_PER_M: Record<string, number> = {
  'claude-opus-4-8': 15,
  'claude-fable-5': 15,
  'claude-sonnet-4-6': 3,
  'claude-haiku-4-5': 0.80,
}

function countKeywordHits(text: string, keywords: string[]): number {
  const lower = text.toLowerCase()
  return keywords.filter(kw => {
    // Support simple regex-like dot wildcard used in OPUS_KEYWORDS
    const pattern = kw.replace('.', '.')
    return lower.includes(pattern) || new RegExp(pattern).test(lower)
  }).length
}

function modelCostPerM(model: string): number {
  const base = model.replace(/\[.*\]$/, '').trim()
  for (const [prefix, cost] of Object.entries(MODEL_COST_PER_M)) {
    if (base.startsWith(prefix)) return cost
  }
  return 3
}

function normalize(m: string): string {
  return m.replace(/\[.*\]$/, '').trim()
}

function buildReason(
  currentModel: string,
  suggestedModel: string,
  contextTokens: number,
  opusKeyHits: number,
  haikuKeyHits: number,
  opusSignalHits: number,
  haikuSignalHits: number,
  signals: AgentSignals | undefined,
  changeAdvised: boolean,
  contextOverride: boolean,
): string {
  const s = signals ?? {}
  const lines: string[] = []

  // Section 1: Jelenlegi állapot
  const verdict = changeAdvised ? 'váltás javasolt' : 'megfelelő'
  lines.push(`Jelenlegi modell: ${currentModel} | Javaslat: ${suggestedModel} (${verdict})`)
  lines.push('')

  // Section 2: Megfigyelt használat
  lines.push('Megfigyelt használat:')
  const tokenStr = s.tokenAvgInputPerCall !== undefined
    ? `${(s.tokenAvgInputPerCall / 1000).toFixed(1)}K token/hívás (30 nap átlag)`
    : 'nincs adat'
  const kanbanStr = s.kanbanOpenCount !== undefined
    ? `${s.kanbanOpenCount} aktív kártya${s.kanbanUrgentCount ? `, ebből ${s.kanbanUrgentCount} sürgős/magas` : ''}`
    : 'nincs adat'
  const schedStr = s.scheduledFreqPerDay !== undefined
    ? `~${Math.round(s.scheduledFreqPerDay)}x/nap`
    : 'nincs adat'
  const mcpStr = s.mcpServerCount !== undefined
    ? `${s.mcpServerCount} MCP szerver`
    : 'nincs adat'
  lines.push(`  Token-fogyasztás: ${tokenStr}`)
  lines.push(`  Kanban-terhelés: ${kanbanStr}`)
  lines.push(`  Ütemezési frekvencia: ${schedStr}`)
  lines.push(`  Integráció-mélység: ${mcpStr}`)
  lines.push('')

  // Section 3: Szempont-értékelés
  lines.push('Szempont-értékelés:')

  const personaIcon = opusKeyHits >= 2 ? '❌' : haikuKeyHits >= 2 ? '✅' : '⚠️'
  const personaDesc = opusKeyHits >= 2
    ? `Opus-jellegű (${opusKeyHits} opus-jelző, ${haikuKeyHits} haiku-jelző)`
    : haikuKeyHits >= 2
      ? `Haiku-elegendő (${haikuKeyHits} haiku-jelző, ${opusKeyHits} opus-jelző)`
      : `Általános (${opusKeyHits} opus-jelző, ${haikuKeyHits} haiku-jelző)`
  lines.push(`  Persona komplexitás: ${personaIcon} ${personaDesc}`)

  const tokenIcon = s.tokenAvgInputPerCall === undefined ? '⚠️'
    : s.tokenAvgInputPerCall > 10_000 ? '❌'
    : s.tokenAvgInputPerCall > 3_000 ? '⚠️'
    : '✅'
  const tokenDesc = s.tokenAvgInputPerCall === undefined ? 'nincs adat'
    : s.tokenAvgInputPerCall > 10_000 ? 'magas -- komplex, hosszú kontextus'
    : s.tokenAvgInputPerCall > 3_000 ? 'közepes'
    : 'alacsony'
  lines.push(`  Token-fogyasztás: ${tokenIcon} ${tokenDesc}`)

  const kanbanIcon = s.kanbanUrgentCount === undefined ? '⚠️'
    : s.kanbanUrgentCount >= 2 ? '❌'
    : (s.kanbanOpenCount ?? 0) === 0 ? '✅'
    : '⚠️'
  const kanbanDesc = s.kanbanUrgentCount === undefined ? 'nincs adat'
    : s.kanbanUrgentCount >= 2 ? `${s.kanbanUrgentCount} sürgős/magas prioritású feladat`
    : (s.kanbanOpenCount ?? 0) === 0 ? 'nincs aktív feladat'
    : 'normál terhelés'
  lines.push(`  Kanban-terhelés: ${kanbanIcon} ${kanbanDesc}`)

  const schedIcon = s.scheduledFreqPerDay === undefined ? '⚠️'
    : s.scheduledFreqPerDay >= 10 ? '✅'
    : '⚠️'
  const schedDesc = s.scheduledFreqPerDay === undefined ? 'nincs adat'
    : s.scheduledFreqPerDay >= 10 ? `sűrű heartbeat (${Math.round(s.scheduledFreqPerDay)}x/nap) -- Haiku elegendő`
    : `ritka/közepes (${Math.round(s.scheduledFreqPerDay ?? 0)}x/nap)`
  lines.push(`  Ütemezési frekvencia: ${schedIcon} ${schedDesc}`)

  const mcpIcon = s.mcpServerCount === undefined ? '⚠️'
    : s.mcpServerCount >= 4 ? '❌'
    : s.mcpServerCount >= 2 ? '⚠️'
    : '✅'
  const mcpDesc = s.mcpServerCount === undefined ? 'nincs adat'
    : s.mcpServerCount >= 4 ? `${s.mcpServerCount} MCP szerver -- gazdag tool-chain`
    : s.mcpServerCount >= 2 ? `${s.mcpServerCount} MCP szerver`
    : `${s.mcpServerCount ?? 0} MCP szerver -- minimális integráció`
  lines.push(`  Integráció-mélység: ${mcpIcon} ${mcpDesc}`)
  lines.push('')

  // Section 4: Ajánlás + 2 fő szempont
  const topReasons: string[] = []
  if (contextOverride) {
    topReasons.push(`nagy session-kontextus (${Math.round(contextTokens / 1000)}K token)`)
  } else {
    if (opusKeyHits >= 2) topReasons.push(`persona ${opusKeyHits} opus-jelzőt tartalmaz`)
    if ((s.tokenAvgInputPerCall ?? 0) > 10_000) topReasons.push(`magas token-fogyasztás (${(s.tokenAvgInputPerCall! / 1000).toFixed(1)}K/hívás)`)
    if ((s.mcpServerCount ?? 0) >= 4) topReasons.push(`${s.mcpServerCount} MCP integráció`)
    if ((s.kanbanUrgentCount ?? 0) >= 2) topReasons.push(`${s.kanbanUrgentCount} sürgős/magas feladat`)
    if (haikuKeyHits >= 2) topReasons.push(`persona ${haikuKeyHits} haiku-jelzőt tartalmaz`)
    if ((s.scheduledFreqPerDay ?? 0) >= 10) topReasons.push(`sűrű heartbeat (${Math.round(s.scheduledFreqPerDay!)}x/nap)`)
  }
  const reasonText = topReasons.slice(0, 2).join('; ') || 'általános szempont alapján'
  lines.push(`Ajánlás: ${suggestedModel} -- ${reasonText}.`)
  lines.push('')

  // Section 5: Becsült költséghatás
  const currentCost = modelCostPerM(currentModel)
  const suggestedCost = modelCostPerM(suggestedModel)
  if (currentCost !== suggestedCost) {
    const pct = Math.round((suggestedCost / currentCost - 1) * 100)
    const dir = pct > 0 ? `+${pct}% drágább` : `${Math.abs(pct)}% olcsóbb`
    lines.push(`Becsült költséghatás: $${currentCost}/M → $${suggestedCost}/M input token (${dir}).`)
  } else {
    lines.push(`Becsült költséghatás: azonos árszint ($${currentCost}/M input token).`)
  }
  lines.push('')

  // Section 6: Bizonytalanság
  const unknowns: string[] = []
  if (s.tokenAvgInputPerCall === undefined) unknowns.push('token-adat hiányzik')
  if (s.kanbanOpenCount === undefined) unknowns.push('kanban-adat hiányzik')
  if (s.scheduledFreqPerDay === undefined) unknowns.push('ütemezési adat hiányzik')
  if (s.mcpServerCount === undefined) unknowns.push('MCP-konfig hiányzik')
  lines.push(unknowns.length > 0
    ? `Bizonytalanság: ${unknowns.join('; ')}.`
    : 'Bizonytalanság: minden szempont adattal alátámasztott.')

  return lines.join('\n')
}

/**
 * Classify a persona into a model tier based on the persona text and
 * optional context-window usage. Deterministic and side-effect-free.
 *
 * @param personaText  Concatenated CLAUDE.md + SOUL.md content (or either)
 * @param contextTokens  Current session context size (0 = unknown / not running)
 */
export function classifyPersona(
  personaText: string,
  contextTokens = 0,
): ModelSuggestion {
  const opusHits = countKeywordHits(personaText, OPUS_KEYWORDS)
  const haikuHits = countKeywordHits(personaText, HAIKU_KEYWORDS)

  // Context-window override: very large sessions always need Opus
  if (contextTokens > 150_000) {
    return {
      suggestedModel: 'claude-opus-4-8[1m]',
      reason: `Nagy session-kontextus (${Math.round(contextTokens / 1000)}K token) -- Opus 4.8 ajánlott a hosszú memóriakezeléshez.`,
      changeAdvised: true,
    }
  }

  if (opusHits >= 2) {
    return {
      suggestedModel: 'claude-opus-4-8[1m]',
      reason: `A persona architektúra/koordináció/komplex feladatokra utal (${opusHits} egyező jelző) -- Opus 4.8 ajánlott.`,
      changeAdvised: true,
    }
  }

  if (haikuHits >= 2 && opusHits === 0) {
    return {
      suggestedModel: 'claude-haiku-4-5-20251001',
      reason: `A persona rövid, ismétlődő vagy fizikai/adminisztratív feladatokra utal (${haikuHits} egyező jelző) -- Haiku 4.5 elegendő és olcsóbb.`,
      changeAdvised: true,
    }
  }

  // Default: Sonnet is the balanced general-purpose choice
  return {
    suggestedModel: 'claude-sonnet-4-6',
    reason: 'Általános célú ágens -- Sonnet 4.6 ajánlott (egyensúly minőség és sebesség között).',
    changeAdvised: true, // caller compares to currentModel to decide final changeAdvised
  }
}

/**
 * Full multi-signal suggestion for a single agent.
 * classifyPersona handles persona keywords; signals add runtime observations.
 * All I/O (token queries, DB, filesystem) happens in the caller -- this stays pure.
 */
export function suggestForAgent(
  agentName: string,
  currentModel: ModelId,
  personaText: string,
  contextTokens = 0,
  signals?: AgentSignals,
): AgentSuggestionResult {
  const s = signals ?? {}

  // Context-window override takes priority over everything
  const contextOverride = contextTokens > 150_000
  if (contextOverride) {
    const suggestedModel = 'claude-opus-4-8[1m]'
    const changeAdvised = normalize(suggestedModel) !== normalize(currentModel)
    return {
      agent: agentName,
      currentModel,
      suggestedModel,
      reason: buildReason(currentModel, suggestedModel, contextTokens, 0, 0, 0, 0, s, changeAdvised, true),
      changeAdvised,
    }
  }

  // Keyword scoring (persona-based)
  const opusKeyHits = countKeywordHits(personaText, OPUS_KEYWORDS)
  const haikuKeyHits = countKeywordHits(personaText, HAIKU_KEYWORDS)

  // Signal scoring (runtime observations)
  let opusSignalHits = 0
  let haikuSignalHits = 0
  if ((s.tokenAvgInputPerCall ?? 0) > 10_000) opusSignalHits++
  if ((s.mcpServerCount ?? 0) >= 4) opusSignalHits++
  if ((s.kanbanUrgentCount ?? 0) >= 2) opusSignalHits++
  if ((s.scheduledFreqPerDay ?? 0) >= 10) haikuSignalHits++

  const totalOpus = opusKeyHits + opusSignalHits
  const totalHaiku = haikuKeyHits + haikuSignalHits

  let suggestedModel: ModelId
  if (totalOpus >= 2) suggestedModel = 'claude-opus-4-8[1m]'
  else if (totalHaiku >= 2 && totalOpus === 0) suggestedModel = 'claude-haiku-4-5-20251001'
  else suggestedModel = 'claude-sonnet-4-6'

  const changeAdvised = normalize(suggestedModel) !== normalize(currentModel)

  return {
    agent: agentName,
    currentModel,
    suggestedModel,
    reason: buildReason(
      currentModel, suggestedModel, contextTokens,
      opusKeyHits, haikuKeyHits, opusSignalHits, haikuSignalHits,
      s, changeAdvised, false,
    ),
    changeAdvised,
  }
}
