import { logger } from '../../logger.js'
import { getSecret } from '../vault.js'
import { loadOpenRouterCatalog, fetchAllOpenRouterModels, loadCuratedManual, addCuratedManual, removeCuratedManual } from '../openrouter-models.js'
import { readClaudePlans } from '../claude-plans.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleAgentsModels(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // Lists every model the dashboard is willing to serve up to an agent.
  // Claude IDs are static. DeepSeek is gated behind a vault secret because
  // the agent-process launcher reads the key from there at start time --
  // surfacing the option in the UI without the key would let the operator
  // pick a model that 401s on first prompt. The frontend renders this list
  // both in the "new agent" wizard and the agent edit panel.
  if (path === '/api/models/available' && method === 'GET') {
    const hasDeepseek = getSecret('DEEPSEEK_API_KEY') !== null
    // OpenRouter is gated behind the vault key, same as DeepSeek: surfacing the
    // options without the key would let the operator pick a model that 401s.
    const hasOpenRouter = getSecret('openrouter-fleet-key') !== null
    const orCatalog = loadOpenRouterCatalog()
    json(res, {
      claude: [
        { id: 'claude-fable-5', label: 'Fable 5 (legújabb)' },
        { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M kontextus, alapértelmezett)' },
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
        { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (leggyorsabb)' },
      ],
      deepseek: hasDeepseek
        ? [
            { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro (1M kontextus, erősebb)' },
            { id: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash (1M kontextus, gyorsabb/olcsóbb)' },
          ]
        : [],
      deepseekConfigured: hasDeepseek,
      // OpenRouter tiers for the model picker. `auto` per tier feeds the "Auto"
      // mode (stored as `openrouter-auto:<tierKey>`, resolved weekly-fresh at
      // launch); `manual` (2 ids) feeds the "Manual" mode.
      openrouter: hasOpenRouter
        ? {
            updated: orCatalog.updated,
            tiers: orCatalog.tiers.map(t => ({
              key: t.key,
              label: t.label,
              autoId: `openrouter-auto:${t.key}`,
              auto: t.auto,
              manual: t.manual,
            })),
          }
        : null,
      // User-curated manual models (ticked in the main agent's browse popup).
      // Feeds the "OpenRouter - kézi" optgroup in every agent's model dropdown.
      openrouterManual: hasOpenRouter ? loadCuratedManual() : [],
      openrouterConfigured: hasOpenRouter,
    })
    return true
  }

  // Curated manual-model list read/toggle. Curation is main-agent-only in the UI
  // (the browse popup is hidden for sub-agents), but the API just gates on the
  // vault key; the ticked set is shared across all agents' dropdowns.
  if (path === '/api/openrouter/manual' && method === 'GET') {
    if (getSecret('openrouter-fleet-key') === null) {
      json(res, { error: 'OpenRouter not configured' }, 403)
      return true
    }
    json(res, { models: loadCuratedManual() })
    return true
  }
  if (path === '/api/openrouter/manual' && method === 'POST') {
    if (getSecret('openrouter-fleet-key') === null) {
      json(res, { error: 'OpenRouter not configured' }, 403)
      return true
    }
    const body = await readBody(req)
    const { id, name, checked } = JSON.parse(body.toString()) as { id?: string; name?: string; checked?: boolean }
    if (!id || typeof id !== 'string') { json(res, { error: 'id is required' }, 400); return true }
    const models = checked ? addCuratedManual(id, name || id) : removeCuratedManual(id)
    json(res, { ok: true, models })
    return true
  }

  // Full OpenRouter model list for the manual "browse all" picker popup.
  // Gated behind the vault key like the tier group. The upstream /models list
  // is public; the module caches it for 6h.
  if (path === '/api/openrouter/models' && method === 'GET') {
    if (getSecret('openrouter-fleet-key') === null) {
      json(res, { error: 'OpenRouter not configured' }, 403)
      return true
    }
    try {
      const models = await fetchAllOpenRouterModels(Date.now())
      json(res, { models })
    } catch (err) {
      logger.warn({ err }, 'openrouter models list fetch failed')
      json(res, { error: 'Could not fetch OpenRouter models' }, 502)
    }
    return true
  }

  // Named Claude subscription registry (store/claude-plans.json), resolved +
  // validated. Feeds the per-agent plan dropdown; empty array when no registry
  // file exists (opt-in feature). Read-only in PR1 -- editing the registry is a
  // separate surface.
  if (path === '/api/claude-plans' && method === 'GET') {
    json(res, readClaudePlans())
    return true
  }

  return false
}
