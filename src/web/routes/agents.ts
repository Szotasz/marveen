import type { RouteContext } from './types.js'
import { tryHandleAgentsModels } from './agents-models.js'
import { tryHandleAgentsProcess } from './agents-process.js'
import {
  tryHandleAgentsChannels,
  isManagedSettingsReady,
  getManagedSettingsSudoCommand,
  setAgentEnabledPlugins,
  resetAgentEnabledPlugins,
} from './agents-channels.js'
import { tryHandleAgentsCrud } from './agents-crud.js'

// Re-exports for backward compatibility (tests import from this module)
export { validateDiscordChannelId } from './agents-helpers.js'
export { isManagedSettingsReady, getManagedSettingsSudoCommand, setAgentEnabledPlugins, resetAgentEnabledPlugins } from './agents-channels.js'

export async function tryHandleAgents(ctx: RouteContext, webDir: string): Promise<boolean> {
  if (await tryHandleAgentsModels(ctx)) return true
  if (await tryHandleAgentsChannels(ctx)) return true
  if (await tryHandleAgentsProcess(ctx)) return true
  if (await tryHandleAgentsCrud(ctx, webDir)) return true
  return false
}
