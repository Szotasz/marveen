import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock vault before importing provider-dispatch so getSecret is controlled
vi.mock('../web/vault.js', () => ({
  getSecret: vi.fn(),
}))

// Mock config so OLLAMA_URL is deterministic
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, OLLAMA_URL: 'http://localhost:11434' }
})

import { buildProviderEnv } from '../web/provider-dispatch.js'
import { getSecret } from '../web/vault.js'

const mockGetSecret = vi.mocked(getSecret)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildProviderEnv', () => {
  describe('Claude models (native -- no extra env)', () => {
    it('returns empty string for a standard Claude model', () => {
      expect(buildProviderEnv('claude-sonnet-5')).toBe('')
    })

    it('returns empty string for claude-opus-5', () => {
      expect(buildProviderEnv('claude-opus-5')).toBe('')
    })

    it('returns empty string for the bracketed 1M-context variant', () => {
      // The [1m] suffix must not be mistaken for another provider
      expect(buildProviderEnv('claude-opus-4-8[1m]')).toBe('')
    })

    it('does not call getSecret for Claude models', () => {
      buildProviderEnv('claude-haiku-4-5')
      expect(mockGetSecret).not.toHaveBeenCalled()
    })
  })

  describe('Ollama models', () => {
    it('sets ollama auth token, base URL, and ANTHROPIC_MODEL', () => {
      const env = buildProviderEnv('llama3.2')
      expect(env).toContain('export ANTHROPIC_AUTH_TOKEN=ollama')
      expect(env).toContain('export ANTHROPIC_BASE_URL=http://localhost:11434')
      expect(env).toContain("export ANTHROPIC_MODEL='llama3.2'")
      expect(env.endsWith(' && ')).toBe(true)
    })

    it('single-quotes a model tag containing a colon', () => {
      const env = buildProviderEnv('qwen3:27b')
      expect(env).toContain("export ANTHROPIC_MODEL='qwen3:27b'")
    })

    it('escapes a single-quote inside the model tag', () => {
      const env = buildProviderEnv("weird'tag")
      expect(env).toContain("export ANTHROPIC_MODEL='weird'\\''tag'")
    })

    it('does not call getSecret for Ollama models', () => {
      buildProviderEnv('llama3.2')
      expect(mockGetSecret).not.toHaveBeenCalled()
    })
  })

  describe('Deepseek models', () => {
    it('sets the Deepseek base URL and API key from vault', () => {
      mockGetSecret.mockReturnValue('dskey-abc123')
      const env = buildProviderEnv('deepseek-v3')
      expect(env).toContain('export ANTHROPIC_AUTH_TOKEN="dskey-abc123"')
      expect(env).toContain('export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic')
      expect(env).toContain("export ANTHROPIC_MODEL='deepseek-v3'")
      expect(env.endsWith(' && ')).toBe(true)
    })

    it('uses an empty key when vault returns null', () => {
      mockGetSecret.mockReturnValue(null)
      const env = buildProviderEnv('deepseek-coder')
      expect(env).toContain('export ANTHROPIC_AUTH_TOKEN=""')
    })

    it('fetches DEEPSEEK_API_KEY from vault', () => {
      mockGetSecret.mockReturnValue('key')
      buildProviderEnv('deepseek-v4-pro')
      expect(mockGetSecret).toHaveBeenCalledWith('DEEPSEEK_API_KEY')
    })
  })

  describe('OpenRouter models', () => {
    it('sets the OpenRouter base URL and key from vault', () => {
      mockGetSecret.mockReturnValue('orkey-xyz')
      const env = buildProviderEnv('anthropic/claude-opus-5')
      expect(env).toContain('export ANTHROPIC_AUTH_TOKEN="orkey-xyz"')
      expect(env).toContain('export ANTHROPIC_BASE_URL=https://openrouter.ai/api')
      expect(env).toContain("export ANTHROPIC_MODEL='anthropic/claude-opus-5'")
      expect(env.endsWith(' && ')).toBe(true)
    })

    it('fetches openrouter-fleet-key from vault', () => {
      mockGetSecret.mockReturnValue('k')
      buildProviderEnv('meta-llama/llama-3-70b')
      expect(mockGetSecret).toHaveBeenCalledWith('openrouter-fleet-key')
    })

    it('treats provider/model with slash as OpenRouter, not Ollama', () => {
      mockGetSecret.mockReturnValue('k')
      const env = buildProviderEnv('mistralai/mistral-large')
      expect(env).toContain('openrouter.ai')
      expect(env).not.toContain('localhost:11434')
    })

    it('uses empty key when vault returns null', () => {
      mockGetSecret.mockReturnValue(null)
      const env = buildProviderEnv('openai/gpt-4o')
      expect(env).toContain('export ANTHROPIC_AUTH_TOKEN=""')
    })
  })

  describe('Discriminator edge cases', () => {
    it('Deepseek wins over Ollama (starts with deepseek-)', () => {
      mockGetSecret.mockReturnValue('k')
      const env = buildProviderEnv('deepseek-coder:latest')
      // deepseek tag even with colon -> Deepseek path, not Ollama
      expect(env).toContain('deepseek.com')
    })

    it('a model starting with claude- is never routed to Ollama even if it has a colon', () => {
      // Hypothetical; real model ids are allowlist-validated upstream, but
      // buildProviderEnv must be conservative on its own.
      expect(buildProviderEnv('claude-custom:v1')).toBe('')
    })

    it('returned env always ends with " && " for non-Claude providers', () => {
      mockGetSecret.mockReturnValue('k')
      const models = ['llama3', 'deepseek-v3', 'openai/gpt-4o']
      for (const m of models) {
        expect(buildProviderEnv(m).endsWith(' && ')).toBe(true)
      }
    })
  })
})
