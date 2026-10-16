import { describe, it, expect } from 'vitest'
import { resolveProviderEnv } from '../web/agent-process.js'
import type { CustomProviderDef } from '../web/custom-providers.js'

describe('resolveProviderEnv', () => {
  it('returns no export chain for a claude- model (uses host OAuth/API key elsewhere)', () => {
    const r = resolveProviderEnv('claude-sonnet-5', () => null)
    expect(r.provider).toBe('claude')
    expect(r.exportsStr).toBe('')
  })

  it('routes deepseek- models to the DeepSeek Anthropic-compatible endpoint with DEEPSEEK_API_KEY', () => {
    const seen: string[] = []
    const r = resolveProviderEnv('deepseek-v4-pro', (id) => {
      seen.push(id)
      return `"$(cat '/tmp/ref-${id}')"`
    })
    expect(r.provider).toBe('deepseek')
    expect(seen).toEqual(['DEEPSEEK_API_KEY'])
    // A HIVATKOZAS megy at, nem az ertek (LATENSKULCSARGV920).
    expect(r.exportsStr).toContain(`ANTHROPIC_AUTH_TOKEN="$(cat '/tmp/ref-DEEPSEEK_API_KEY')"`)
    expect(r.exportsStr).toContain('ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic')
    expect(r.exportsStr).toContain(`ANTHROPIC_MODEL='deepseek-v4-pro'`)
  })

  it('routes minimax- models to the MiniMax Anthropic-compatible endpoint with MINIMAX_API_KEY', () => {
    const seen: string[] = []
    const r = resolveProviderEnv('minimax-m3', (id) => {
      seen.push(id)
      return `"$(cat '/tmp/ref-${id}')"`
    })
    expect(r.provider).toBe('minimax')
    expect(seen).toEqual(['MINIMAX_API_KEY'])
    expect(r.exportsStr).toContain(`ANTHROPIC_AUTH_TOKEN="$(cat '/tmp/ref-MINIMAX_API_KEY')"`)
    expect(r.exportsStr).toContain('ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic')
    expect(r.exportsStr).toContain(`ANTHROPIC_MODEL='minimax-m3'`)
  })

  it('forces CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000 for minimax- models -- the /anthropic compat layer misreports 200K (MiniMax-AI/MiniMax-M2.7#46), so the CLI must be told the real window explicitly', () => {
    const r = resolveProviderEnv('minimax-m3', () => `"$(cat '/tmp/ref')"`)
    expect(r.exportsStr).toContain('CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000')
  })

  it('does NOT force CLAUDE_CODE_MAX_CONTEXT_TOKENS for a claude- model -- the override is minimax-specific, not a blanket setting', () => {
    const r = resolveProviderEnv('claude-sonnet-5', () => null)
    expect(r.exportsStr).not.toContain('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
  })

  it('routes provider/model ids (containing "/") to OpenRouter, not minimax or ollama', () => {
    const seen: string[] = []
    const r = resolveProviderEnv('minimax/minimax-m3', (id) => {
      seen.push(id)
      return `"$(cat '/tmp/ref-${id}')"`
    })
    expect(r.provider).toBe('openrouter')
    expect(seen).toEqual(['openrouter-fleet-key'])
    expect(r.exportsStr).toContain('ANTHROPIC_BASE_URL=https://openrouter.ai/api')
  })

  it('falls back to Ollama for a bare tag (no "claude-"/"deepseek-"/"minimax-" prefix, no "/")', () => {
    const r = resolveProviderEnv('qwen3.6:27b', () => null)
    expect(r.provider).toBe('ollama')
    expect(r.exportsStr).toContain('ANTHROPIC_AUTH_TOKEN=ollama')
    expect(r.exportsStr).toContain(`ANTHROPIC_MODEL='qwen3.6:27b'`)
  })

  it('a titok ERTEKE sosem jut el a fuggvenyig: ami athalad, az hivatkozas (LATENSKULCSARGV920)', () => {
    // NEGATIV KONTROLL a javitas lenyegere. A hivo `launchSecretRef`-et ad at, ami FAJLBA teszi a
    // titkot; ide mar csak a `$(cat ...)` alak jon. Ha valaki visszaallitana az ertek-atadast, ez
    // az allitas piros lesz -- es vele az a tulajdonsag bukik, hogy a launch-parancs (es a `ps`
    // sora) nem hordozza a kulcsot.
    const TITOK = 'PROBA-ERTEK-ez-soha-nem-lathat-a-ps-ben'
    for (const model of ['deepseek-v4-pro', 'minimax-m3', 'minimax/minimax-m3']) {
      const r = resolveProviderEnv(model, () => `"$(cat '/tmp/kulcs-fajl')"`)
      expect(r.exportsStr, model).not.toContain(TITOK)
      expect(r.exportsStr, model).toContain(`$(cat '/tmp/kulcs-fajl')`)
    }
  })

  it('hivatkozas nelkul (nincs titok) URES ertek megy ki, nem a "null" szo', () => {
    const r = resolveProviderEnv('deepseek-v4-pro', () => null)
    expect(r.exportsStr).toContain('ANTHROPIC_AUTH_TOKEN=""')
    expect(r.exportsStr).not.toContain('null')
    expect(r.exportsStr).not.toContain('undefined')
  })

  it('never asks the secret lookup for a claude- model', () => {
    let called = false
    resolveProviderEnv('claude-sonnet-5', () => {
      called = true
      return 'unused'
    })
    expect(called).toBe(false)
  })

  // REGRESSZIOS ORZO: a custom-provider vault-kulcs hianya megallitja az inditast,
  // nem esik vissza csendben a rossz backendre. Ez a check kivehetetlen anelkul,
  // hogy ez a teszt piros ne legyen -- korabban semmilyen teszt nem pinnelte le
  // (Szotasz FIX-THEN-GO merese: a check kivetele mellett is 6537/6537 zold volt).
  for (const authHeader of ['x-api-key', 'Bearer'] as const) {
    it(`throws when a custom provider's vault key (authHeader=${authHeader}) has no secret, instead of launching without one`, () => {
      const def: CustomProviderDef = {
        id: 'my-provider',
        label: 'My Provider',
        baseUrl: 'https://api.example.com',
        authHeader,
        vaultKey: 'missing-vault-key',
      }
      const seen: string[] = []
      expect(() => resolveProviderEnv('some-model', (id) => {
        seen.push(id)
        return null // a hivo pontosan ezt adja vissza, ha a vault-kulcshoz nincs titok
      }, def)).toThrow(/missing-vault-key/)
      expect(seen).toEqual(['missing-vault-key'])
    })
  }

  it("does NOT throw for authHeader='none' even when the vault key lookup would fail -- no key is needed on that path", () => {
    const def: CustomProviderDef = {
      id: 'ollama-like',
      label: 'No-auth provider',
      baseUrl: 'http://localhost:11434',
      authHeader: 'none',
      vaultKey: null,
    }
    const r = resolveProviderEnv('some-model', () => null, def)
    expect(r.provider).toBe('custom')
    expect(r.exportsStr).toContain('ANTHROPIC_AUTH_TOKEN=ollama')
  })
})
