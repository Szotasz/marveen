import { OLLAMA_URL } from '../config.js'
import { getSecret } from './vault.js'

// Local copy -- avoids a circular dep with agent-process.ts which both exports
// shSingleQuote and will import buildProviderEnv from here.
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Builds the shell env-var prefix fragment for a given model id.
 *
 * Returns an empty string for native Claude models (auth is handled by the
 * caller via OAuth / ANTHROPIC_API_KEY). For every other provider the returned
 * string ends with ` && ` so it can be prepended directly to the rest of the
 * launch command.
 *
 * The caller is responsible for any model-id resolution (e.g.
 * resolveOpenRouterModel) before passing the value in.
 *
 * ANTHROPIC_MODEL is required for non-Claude models: the interactive TUI
 * validates --model against known Anthropic model names and silently falls back
 * to its built-in default for unrecognised values (card b7fa5281). The env var
 * is authoritative and bypasses that validation.
 */
export function buildProviderEnv(model: string): string {
  const isClaude = model.startsWith('claude-')
  const isDeepseek = model.startsWith('deepseek-')
  // OpenRouter ids are `provider/model` (contain '/'); Ollama tags use ':' and
  // no '/'. This discriminator keeps OpenRouter ids off the Ollama path.
  const isOpenRouter = !isClaude && !isDeepseek && model.includes('/')
  const isOllama = !isClaude && !isDeepseek && !isOpenRouter

  if (isOllama) {
    return `export ANTHROPIC_AUTH_TOKEN=ollama && export ANTHROPIC_BASE_URL=${OLLAMA_URL} && export ANTHROPIC_MODEL=${shSingleQuote(model)} && `
  }
  if (isDeepseek) {
    const key = getSecret('DEEPSEEK_API_KEY') ?? ''
    return `export ANTHROPIC_AUTH_TOKEN="${key}" && export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic && export ANTHROPIC_MODEL=${shSingleQuote(model)} && `
  }
  if (isOpenRouter) {
    const key = getSecret('openrouter-fleet-key') ?? ''
    return `export ANTHROPIC_AUTH_TOKEN="${key}" && export ANTHROPIC_BASE_URL=https://openrouter.ai/api && export ANTHROPIC_MODEL=${shSingleQuote(model)} && `
  }
  // Claude: no extra env needed; caller handles OAuth / API key
  return ''
}
