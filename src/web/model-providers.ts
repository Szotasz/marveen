import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OLLAMA_URL } from '../config.js'
import { getSecret } from './vault.js'

export type ProviderRuntime = 'claude-tui' | 'codex-exec'
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh'

export interface ProviderModel {
  id: string
  label: string
}

export interface ModelProvider {
  key: string
  label: string
  runtime: ProviderRuntime
  configured(): boolean
  models(): ProviderModel[]
  matches(modelId: string): boolean
  envPrefix?(modelId: string): string
  /** Presence of levels is the executable capability; the API also exposes
   *  an explicit supportsEffort boolean for generic dashboard clients. */
  effortLevels?: EffortLevel[]
}

const CLAUDE_MODELS: ProviderModel[] = [
  { id: 'claude-fable-5', label: 'Fable 5 (latest)' },
  { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M context, default)' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (fastest)' },
]

const DEEPSEEK_MODELS: ProviderModel[] = [
  { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro (1M context)' },
  { id: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash (fast)' },
]

const CODEX_MODELS: ProviderModel[] = [
  { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol' },
]

export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  {
    key: 'claude',
    label: 'Claude (cloud)',
    runtime: 'claude-tui',
    configured: () => true,
    models: () => CLAUDE_MODELS,
    matches: modelId => modelId.startsWith('claude-'),
    envPrefix: () => '',
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    runtime: 'claude-tui',
    configured: () => getSecret('DEEPSEEK_API_KEY') !== null,
    models: () => DEEPSEEK_MODELS,
    matches: modelId => modelId.startsWith('deepseek-'),
    envPrefix: modelId => {
      const key = getSecret('DEEPSEEK_API_KEY') ?? ''
      return `export ANTHROPIC_AUTH_TOKEN="${key}" && export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic && export ANTHROPIC_MODEL='${modelId}' && `
    },
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    runtime: 'claude-tui',
    configured: () => getSecret('openrouter-fleet-key') !== null,
    models: () => [],
    matches: modelId => modelId.startsWith('openrouter-auto:') || modelId.includes('/'),
    envPrefix: modelId => {
      const key = getSecret('openrouter-fleet-key') ?? ''
      return `export ANTHROPIC_AUTH_TOKEN="${key}" && export ANTHROPIC_BASE_URL=https://openrouter.ai/api && export ANTHROPIC_MODEL='${modelId}' && `
    },
  },
  {
    key: 'codex',
    label: 'GPT (Codex)',
    runtime: 'codex-exec',
    configured: () => existsSync(join(homedir(), '.codex', 'auth.json')),
    models: () => CODEX_MODELS,
    matches: modelId => modelId.startsWith('gpt-'),
    effortLevels: ['low', 'medium', 'high'],
  },
  {
    key: 'ollama',
    label: 'Ollama (local)',
    runtime: 'claude-tui',
    configured: () => true,
    models: () => [],
    // Keep last: every pre-registry model shape not claimed above was Ollama.
    matches: () => true,
    envPrefix: modelId =>
      `export ANTHROPIC_AUTH_TOKEN=ollama && export ANTHROPIC_BASE_URL=${OLLAMA_URL} && export ANTHROPIC_MODEL='${modelId}' && `,
  },
]

export function getModelProviderByKey(key: string | null | undefined): ModelProvider | null {
  if (!key) return null
  return MODEL_PROVIDERS.find(provider => provider.key === key) ?? null
}

export function resolveModelProvider(modelId: string, explicitProvider?: string | null): ModelProvider {
  const explicit = getModelProviderByKey(explicitProvider)
  if (explicit) return explicit
  return MODEL_PROVIDERS.find(provider => provider.matches(modelId))!
}

export function providerSupportsEffort(provider: ModelProvider, effort: unknown): effort is EffortLevel {
  return typeof effort === 'string' && (provider.effortLevels?.includes(effort as EffortLevel) ?? false)
}

export function availableProviderCatalog(): Array<{
  key: string
  label: string
  runtime: ProviderRuntime
  configured: boolean
  models: ProviderModel[]
  supportsEffort: boolean
  effortLevels: EffortLevel[]
}> {
  return MODEL_PROVIDERS.map(provider => {
    const configured = provider.configured()
    return {
      key: provider.key,
      label: provider.label,
      runtime: provider.runtime,
      configured,
      models: configured ? provider.models() : [],
      supportsEffort: Boolean(provider.effortLevels?.length),
      effortLevels: provider.effortLevels ? [...provider.effortLevels] : [],
    }
  })
}
