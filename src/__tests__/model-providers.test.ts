import { beforeEach, describe, expect, it, vi } from 'vitest'

const secrets = new Map<string, string>()
vi.mock('../web/vault.js', () => ({
  getSecret: (key: string) => secrets.get(key) ?? null,
}))

import {
  availableProviderCatalog,
  resolveModelProvider,
} from '../web/model-providers.js'
import { resolveAgentModelConfig } from '../web/agent-config.js'
import { OLLAMA_URL } from '../config.js'

describe('multi-provider model registry', () => {
  beforeEach(() => secrets.clear())

  it('keeps every legacy model shape on claude-tui and adds GPT on codex-exec', () => {
    expect(resolveModelProvider('claude-fable-5')).toMatchObject({ key: 'claude', runtime: 'claude-tui' })
    expect(resolveModelProvider('deepseek-v4-pro')).toMatchObject({ key: 'deepseek', runtime: 'claude-tui' })
    expect(resolveModelProvider('openrouter-auto:premium')).toMatchObject({ key: 'openrouter', runtime: 'claude-tui' })
    expect(resolveModelProvider('anthropic/claude-opus-4.6')).toMatchObject({ key: 'openrouter', runtime: 'claude-tui' })
    expect(resolveModelProvider('qwen3.6:27b')).toMatchObject({ key: 'ollama', runtime: 'claude-tui' })
    expect(resolveModelProvider('gpt-5.6-sol')).toMatchObject({ key: 'codex', runtime: 'codex-exec' })
  })

  it('contains Fable, existing Claude models, and Sol with effort capability', () => {
    const catalog = availableProviderCatalog()
    const claude = catalog.find(provider => provider.key === 'claude')!
    expect(claude.models.map(model => model.id)).toEqual(expect.arrayContaining([
      'claude-fable-5',
      'claude-opus-4-8[1m]',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
    ]))
    const codex = catalog.find(provider => provider.key === 'codex')!
    expect(codex.runtime).toBe('codex-exec')
    expect(codex.supportsEffort).toBe(true)
    expect(codex.effortLevels).toEqual(['low', 'medium', 'high'])
    expect(claude.supportsEffort).toBe(false)
  })

  it('preserves the existing Anthropic bridge environment prefixes exactly', () => {
    secrets.set('DEEPSEEK_API_KEY', 'deep-key')
    secrets.set('openrouter-fleet-key', 'or-key')
    expect(resolveModelProvider('qwen:latest').envPrefix?.('qwen:latest')).toBe(
      `export ANTHROPIC_AUTH_TOKEN=ollama && export ANTHROPIC_BASE_URL=${OLLAMA_URL} && export ANTHROPIC_MODEL='qwen:latest' && `,
    )
    expect(resolveModelProvider('deepseek-v4-pro').envPrefix?.('deepseek-v4-pro')).toBe(
      'export ANTHROPIC_AUTH_TOKEN="deep-key" && export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic && export ANTHROPIC_MODEL=\'deepseek-v4-pro\' && ',
    )
    expect(resolveModelProvider('vendor/model').envPrefix?.('vendor/model')).toBe(
      'export ANTHROPIC_AUTH_TOKEN="or-key" && export ANTHROPIC_BASE_URL=https://openrouter.ai/api && export ANTHROPIC_MODEL=\'vendor/model\' && ',
    )
  })

  it('defaults old configs to claude-tui and validates Codex effort', () => {
    expect(resolveAgentModelConfig('{}')).toMatchObject({
      provider: 'claude',
      runtime: 'claude-tui',
      modelEffort: null,
      sandbox: null,
    })
    expect(resolveAgentModelConfig(JSON.stringify({
      model: 'gpt-5.6-sol',
      provider: 'codex',
      runtime: 'codex-exec',
      modelEffort: 'high',
      sandbox: 'danger-full-access',
    }))).toEqual({
      model: 'gpt-5.6-sol',
      provider: 'codex',
      runtime: 'codex-exec',
      modelEffort: 'high',
      sandbox: 'read-only',
    })
    expect(resolveAgentModelConfig(JSON.stringify({
      model: 'gpt-5.6-sol',
      modelEffort: 'unsupported',
    })).modelEffort).toBeNull()
  })
})
