import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// /api/models/available (src/web/routes/agents.ts) has served a `minimax`
// array + `minimaxConfigured` flag since kanban card 964a9567 (direct
// MiniMax API). The dashboard frontend never grew the matching optgroup or
// loadAvailableModels() wiring to render it -- the model is reachable by the
// launcher (agent-process.ts) but unreachable from the "Fej - Beállítások /
// Modell" picker. Reported live 2026-08-18 (Telegram {519}/{520}): the key
// is configured, the picker still shows nothing.

const __dirname = dirname(fileURLToPath(import.meta.url))
const indexHtml = readFileSync(join(__dirname, '..', '..', 'web', 'index.html'), 'utf8')
const appSource = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')

describe('MiniMax option group in the model selector', () => {
  it('wizard "Modell" select has a MiniMax optgroup', () => {
    expect(indexHtml).toContain('id="agentModelMinimaxGroup"')
  })

  it('agent edit panel "Modell" select has a MiniMax optgroup', () => {
    expect(indexHtml).toContain('id="minimaxModelGroup"')
  })

  it('loadAvailableModels() reads data.minimax and populates both groups', () => {
    const start = appSource.indexOf('async function loadAvailableModels()')
    expect(start).toBeGreaterThan(-1)
    const end = appSource.indexOf('\n// --- OpenRouter manual-list curation', start)
    expect(end).toBeGreaterThan(start)
    const body = appSource.slice(start, end)

    expect(body).toContain('data.minimax')
    expect(body).toContain('agentModelMinimaxGroup')
    expect(body).toContain('minimaxModelGroup')
  })
})
