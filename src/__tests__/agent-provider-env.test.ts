import { describe, it, expect } from 'vitest'
import { resolveProviderEnv } from '../web/agent-process.js'

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
      return 'ds-secret'
    })
    expect(r.provider).toBe('deepseek')
    expect(seen).toEqual(['DEEPSEEK_API_KEY'])
    expect(r.exportsStr).toContain('ANTHROPIC_AUTH_TOKEN="ds-secret"')
    expect(r.exportsStr).toContain('ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic')
    expect(r.exportsStr).toContain(`ANTHROPIC_MODEL='deepseek-v4-pro'`)
  })

  it('routes minimax- models to the MiniMax Anthropic-compatible endpoint with MINIMAX_API_KEY', () => {
    const seen: string[] = []
    const r = resolveProviderEnv('minimax-m3', (id) => {
      seen.push(id)
      return 'mm-secret'
    })
    expect(r.provider).toBe('minimax')
    expect(seen).toEqual(['MINIMAX_API_KEY'])
    expect(r.exportsStr).toContain('ANTHROPIC_AUTH_TOKEN="mm-secret"')
    expect(r.exportsStr).toContain('ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic')
    expect(r.exportsStr).toContain(`ANTHROPIC_MODEL='minimax-m3'`)
  })

  it('forces CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000 for minimax- models -- the /anthropic compat layer misreports 200K (MiniMax-AI/MiniMax-M2.7#46), so the CLI must be told the real window explicitly', () => {
    const r = resolveProviderEnv('minimax-m3', () => 'mm-secret')
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
      return 'or-secret'
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

  it('never asks the secret lookup for a claude- model', () => {
    let called = false
    resolveProviderEnv('claude-sonnet-5', () => {
      called = true
      return 'unused'
    })
    expect(called).toBe(false)
  })
})
