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

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

export const AUTO_PREFIX = 'openrouter-auto:'
export const OPENROUTER_MODELS_FILE = join(STORE_DIR, 'openrouter-models.json')

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
    { key: 'tier0', label: 'Tier 0 — Free / bulk', auto: 'meta-llama/llama-3.3-70b-instruct:free',
      manual: ['meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen3-coder:free'] },
    { key: 'tier1', label: 'Tier 1 — Workhorse', auto: 'deepseek/deepseek-chat-v3.1',
      manual: ['deepseek/deepseek-chat-v3.1', 'google/gemini-2.5-flash'] },
    { key: 'tier2', label: 'Tier 2 — Code', auto: 'qwen/qwen3-coder',
      manual: ['qwen/qwen3-coder', 'mistralai/codestral-2508'] },
    { key: 'tier3', label: 'Tier 3 — Heavy reasoning', auto: 'anthropic/claude-sonnet-5',
      manual: ['anthropic/claude-sonnet-5', 'google/gemini-3.1-pro'] },
    { key: 'tier4', label: 'Tier 4 — Vision', auto: 'google/gemini-2.5-flash',
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
