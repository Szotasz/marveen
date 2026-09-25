// AGENT_LOCAL_BASE_URL: the local-agent endpoint is a separate setting from
//
// What this pins, and why it is worth pinning:
// OLLAMA_URL has FIVE consumers in this repo. Four of them call the NATIVE
// ollama API (/api/tags, /api/generate): memories.ts, connectors.ts and
// migrate.ts. The fifth, agent-process.ts, only needs an Anthropic-compatible
// /v1/messages endpoint -- here a vLLM proxy that has no /api/tags at all.
// Pointing the ONE key at the proxy fixes the agent and breaks the other four
// SILENTLY: they do not throw, they return empty model lists.
//
// Honest scope. Test 3 is a SOURCE invariant, not a behaviour measurement: it
// exists because the regression we actually fear is an upstream update
// overwriting the local patch, and that shows up in the source before it shows
// up anywhere else. The RUNTIME fact -- that the live agent process really has
// this base URL in its environment, and that the URL answers -- is measured by
// check-agent-base-url.sh, which reads /proc/<pid>/environ. Neither replaces
// the other: this one goes red on a code revert, that one on a stale restart.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_LOCAL_BASE_URL, OLLAMA_URL, PROJECT_ROOT } from '../config.js'
import { SETTINGS_REGISTRY } from '../config-registry.js'

function configuredOverride(): string | undefined {
  const p = join(PROJECT_ROOT, 'store', 'config-overrides.json')
  if (!existsSync(p)) return undefined
  const raw = (JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>)['AGENT_LOCAL_BASE_URL']
  return raw === undefined || raw === null || String(raw).length === 0 ? undefined : String(raw)
}

describe('AGENT_LOCAL_BASE_URL: the local-agent endpoint is its own key', () => {
  it('resolves to the override when one is set, and to OLLAMA_URL when not', () => {
    const override = configuredOverride()
    // Both branches are correct behaviour; silently resolving to some THIRD
    // value is not. An install that really serves its local agent from ollama
    // sets no override and keeps the upstream behaviour untouched.
    expect(AGENT_LOCAL_BASE_URL).toBe(override ?? OLLAMA_URL)
    expect(AGENT_LOCAL_BASE_URL).toMatch(/^https?:\/\/.+/)
  })

  it('is a registered setting, so it is visible and editable on the Settings page', () => {
    // The failure this prevents, measured 2026-09-02: a value that only exists
    // as a hand-set environment variable is invisible on the dashboard and
    // silently reverts on the next restart.
    const def = SETTINGS_REGISTRY.find(s => s.key === 'AGENT_LOCAL_BASE_URL')
    expect(def, 'AGENT_LOCAL_BASE_URL missing from SETTINGS_REGISTRY').toBeDefined()
    expect(def!.requiresRestart).toBe(true)
    expect(def!.default).toBe('')
  })

  it('is what the agent launcher exports as ANTHROPIC_BASE_URL -- not OLLAMA_URL', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'agent-process.ts'), 'utf8')
    // ANCHOR MOVED ONCE ALREADY (2026-09-06, v1.36.0): upstream refactored the
    // per-provider env chain into resolveProviderEnv(), so `const ollamaEnv =`
    // no longer exists and this test went red exactly as designed. The patch was
    // re-verified by hand and re-ported to the new shape (2 lines: the config
    // import and the ollama branch's exportsStr). The anchor is now the ollama
    // auth token, which is what actually marks that branch.
    const line = src.split('\n').find(l => l.includes('ANTHROPIC_AUTH_TOKEN=ollama'))
    expect(line, 'the ollama exportsStr line is gone -- upstream restructured it again, re-verify the patch by hand').toBeDefined()
    expect(line).toContain('ANTHROPIC_BASE_URL=${AGENT_LOCAL_BASE_URL}')
    expect(line).not.toContain('${OLLAMA_URL}')
    // And the module must not reach for OLLAMA_URL by any other route either.
    // Comment lines are stripped first: the rationale block ABOVE the builder
    // names OLLAMA_URL on purpose, and a gate that trips on its own
    // explanation would just teach the next person to delete the explanation.
    const code = src
      .split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .join('\n')
    expect(code).not.toContain('OLLAMA_URL')
  })
})
