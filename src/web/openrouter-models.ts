// OpenRouter fleet-model catalog + auto-tier resolution.
//
// The fleet can run its non-main agents on OpenRouter models. OpenRouter
// exposes an Anthropic-compatible Messages endpoint (https://openrouter.ai/api
// -> /v1/messages), so the launcher points ANTHROPIC_BASE_URL there with the
// openrouter-fleet-key, exactly like the DeepSeek branch -- no proxy needed.
//
// Two selection modes surface in the dashboard:
//   - AUTO: the agent's model is stored as `openrouter-auto:<tierKey>`; at
//     launch we resolve it to the tier's currently-recommended model, so the
//     weekly research task can keep the fleet on the best model without any
//     per-agent re-config.
//   - MANUAL: the agent's model is a concrete OpenRouter id (e.g.
//     `deepseek/deepseek-chat-v3.1`), chosen from the tier's 2 options.
//
// The catalog lives in store/openrouter-models.json (maintained by the
// openrouter-weekly-llm-research scheduled task). A hardcoded default keeps the
// feature working before the first weekly refresh writes the file.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

export const AUTO_PREFIX = 'openrouter-auto:'
export const OPENROUTER_MODELS_FILE = join(STORE_DIR, 'openrouter-models.json')
// User-curated "manual" model list. The main agent's OpenRouter browse popup
// ticks/unticks models here; the ticked set becomes the "OpenRouter - kézi"
// optgroup available in EVERY agent's model dropdown. Curation (this file) is
// deliberately separate from per-agent assignment (writeAgentModel).
export const OPENROUTER_MANUAL_FILE = join(STORE_DIR, 'openrouter-manual.json')

export interface OpenRouterTier {
  key: string
  label: string
  auto: string        // the currently-recommended concrete model id for this tier
  manual: string[]    // 2 selectable concrete model ids
}

export interface OpenRouterCatalog {
  updated: string
  tiers: OpenRouterTier[]
}

// Fallback catalog (fleet-model-allocation.md, 2026-07-13). Used until the
// weekly task writes store/openrouter-models.json.
const DEFAULT_CATALOG: OpenRouterCatalog = {
  updated: '2026-07-13 (default)',
  tiers: [
    { key: 'tier0', label: 'Tier 0 - Free / bulk', auto: 'meta-llama/llama-3.3-70b-instruct:free',
      manual: ['meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen3-coder:free'] },
    { key: 'tier1', label: 'Tier 1 - Workhorse', auto: 'deepseek/deepseek-chat-v3.1',
      manual: ['deepseek/deepseek-chat-v3.1', 'google/gemini-2.5-flash'] },
    { key: 'tier2', label: 'Tier 2 - Code', auto: 'qwen/qwen3-coder',
      manual: ['qwen/qwen3-coder', 'mistralai/codestral-2508'] },
    { key: 'tier3', label: 'Tier 3 - Heavy reasoning', auto: 'anthropic/claude-sonnet-5',
      manual: ['anthropic/claude-sonnet-5', 'google/gemini-3.1-pro'] },
    { key: 'tier4', label: 'Tier 4 - Vision', auto: 'google/gemini-2.5-flash',
      manual: ['google/gemini-2.5-flash', 'qwen/qwen3-vl-30b-a3b-instruct'] },
  ],
}

export function loadOpenRouterCatalog(): OpenRouterCatalog {
  try {
    if (existsSync(OPENROUTER_MODELS_FILE)) {
      const parsed = JSON.parse(readFileSync(OPENROUTER_MODELS_FILE, 'utf-8')) as OpenRouterCatalog
      if (parsed && Array.isArray(parsed.tiers) && parsed.tiers.length > 0) return parsed
    }
  } catch (err) {
    logger.warn({ err }, 'openrouter catalog parse failed; using default')
  }
  return DEFAULT_CATALOG
}

// --- Full catalog for the manual picker ---
// The dashboard "OpenRouter" browse popup lists every model so the operator can
// pick/test any of them (not just the tier picks). OpenRouter's /models list is
// public; we cache it in-memory to avoid re-fetching on every popup open.

export interface OpenRouterModelInfo {
  id: string
  name: string
  contextLength: number
  promptPrice: number      // USD per 1M prompt tokens
  completionPrice: number  // USD per 1M completion tokens
  free: boolean
}

let allModelsCache: { at: number; models: OpenRouterModelInfo[] } | null = null
const ALL_MODELS_TTL_MS = 6 * 60 * 60 * 1000 // 6h

export async function fetchAllOpenRouterModels(nowMs: number): Promise<OpenRouterModelInfo[]> {
  if (allModelsCache && nowMs - allModelsCache.at < ALL_MODELS_TTL_MS) return allModelsCache.models
  const resp = await fetch('https://openrouter.ai/api/v1/models')
  if (!resp.ok) throw new Error(`openrouter models fetch: HTTP ${resp.status}`)
  const data = await resp.json() as { data?: Array<Record<string, unknown>> }
  const models: OpenRouterModelInfo[] = (data.data ?? []).map(m => {
    const pricing = (m.pricing ?? {}) as Record<string, string>
    const prompt = parseFloat(pricing.prompt ?? '0') * 1_000_000
    const completion = parseFloat(pricing.completion ?? '0') * 1_000_000
    return {
      id: String(m.id ?? ''),
      name: String(m.name ?? m.id ?? ''),
      contextLength: Number(m.context_length ?? 0),
      promptPrice: Number.isFinite(prompt) ? prompt : 0,
      completionPrice: Number.isFinite(completion) ? completion : 0,
      free: prompt === 0 && completion === 0,
    }
  }).filter(m => m.id)
  models.sort((a, b) => a.id.localeCompare(b.id))
  allModelsCache = { at: nowMs, models }
  return models
}

// --- User-curated manual model list ---
// The ticked set from the main agent's browse popup. Persisted as a flat list
// so the dropdown's "kézi" optgroup is identical for every agent, while each
// agent still picks its own model from that shared set.

export interface CuratedModel {
  id: string
  name: string
}

export function loadCuratedManual(): CuratedModel[] {
  try {
    if (existsSync(OPENROUTER_MANUAL_FILE)) {
      const parsed = JSON.parse(readFileSync(OPENROUTER_MANUAL_FILE, 'utf-8')) as { models?: CuratedModel[] }
      if (parsed && Array.isArray(parsed.models)) {
        return parsed.models.filter(m => m && typeof m.id === 'string' && m.id)
      }
    }
  } catch (err) {
    logger.warn({ err }, 'openrouter curated-manual parse failed; using empty list')
  }
  return []
}

function saveCuratedManual(models: CuratedModel[]): void {
  writeFileSync(OPENROUTER_MANUAL_FILE, JSON.stringify({ models }, null, 2))
}

// Add a model to the curated list (no-op if already present). Returns the new list.
export function addCuratedManual(id: string, name: string): CuratedModel[] {
  const list = loadCuratedManual()
  if (!list.some(m => m.id === id)) {
    list.push({ id, name: name || id })
    list.sort((a, b) => a.id.localeCompare(b.id))
    saveCuratedManual(list)
  }
  return list
}

// Remove a model from the curated list (no-op if absent). Returns the new list.
export function removeCuratedManual(id: string): CuratedModel[] {
  const list = loadCuratedManual()
  const next = list.filter(m => m.id !== id)
  if (next.length !== list.length) saveCuratedManual(next)
  return next
}

// Resolve a stored model value to a concrete model id the launcher can use.
// `openrouter-auto:<tierKey>` -> that tier's current `auto` model. Anything
// else is returned unchanged. Never throws.
export function resolveOpenRouterModel(model: string): string {
  if (!model.startsWith(AUTO_PREFIX)) return model
  const tierKey = model.slice(AUTO_PREFIX.length)
  const cat = loadOpenRouterCatalog()
  const tier = cat.tiers.find(t => t.key === tierKey)
  if (tier?.auto) return tier.auto
  logger.warn({ model, tierKey }, 'openrouter-auto tier not found; falling back to tier1/deepseek')
  return cat.tiers.find(t => t.key === 'tier1')?.auto ?? 'deepseek/deepseek-chat-v3.1'
}
