import { describe, it, expect } from 'vitest'
import { generateSlackAppManifest, getSlackAppSetupInstructions } from '../channel-provider.js'

describe('generateSlackAppManifest', () => {
  it('returns valid YAML with the app name', () => {
    const yaml = generateSlackAppManifest('TestBot')
    expect(yaml).toContain('name: "TestBot"')
    expect(yaml).toContain('display_name: "TestBot"')
  })

  it('includes all required bot scopes', () => {
    const yaml = generateSlackAppManifest('Bot')
    for (const scope of [
      'app_mentions:read', 'channels:history', 'channels:read',
      'chat:write', 'files:read', 'files:write',
      'groups:history', 'groups:read', 'im:history',
      'im:read', 'im:write', 'reactions:write', 'users:read',
    ]) {
      expect(yaml).toContain(`- ${scope}`)
    }
  })

  it('includes all required bot events', () => {
    const yaml = generateSlackAppManifest('Bot')
    for (const event of ['app_mention', 'message.channels', 'message.groups', 'message.im']) {
      expect(yaml).toContain(`- ${event}`)
    }
  })

  it('enables socket mode', () => {
    const yaml = generateSlackAppManifest('Bot')
    expect(yaml).toContain('socket_mode_enabled: true')
  })

  it('enables interactivity', () => {
    const yaml = generateSlackAppManifest('Bot')
    expect(yaml).toContain('is_enabled: true')
  })

  it('strips quotes and backslashes from app name for valid YAML', () => {
    const yaml = generateSlackAppManifest('My "Bot"')
    expect(yaml).toContain('name: "My Bot"')
    expect(yaml).toContain('display_name: "My Bot"')
  })

  it('strips backslashes from app name', () => {
    const yaml = generateSlackAppManifest('Bot\\Name')
    expect(yaml).toContain('name: "BotName"')
  })
})

describe('getSlackAppSetupInstructions', () => {
  it('returns an array of steps', () => {
    const steps = getSlackAppSetupInstructions()
    expect(Array.isArray(steps)).toBe(true)
    expect(steps.length).toBe(7)
  })

  it('mentions api.slack.com/apps', () => {
    const steps = getSlackAppSetupInstructions()
    expect(steps[0]).toContain('api.slack.com/apps')
  })

  it('mentions bot token (xoxb)', () => {
    const steps = getSlackAppSetupInstructions()
    const tokenStep = steps.find(s => s.includes('xoxb'))
    expect(tokenStep).toBeDefined()
  })

  it('mentions app-level token (xapp)', () => {
    const steps = getSlackAppSetupInstructions()
    const tokenStep = steps.find(s => s.includes('xapp'))
    expect(tokenStep).toBeDefined()
  })

  it('mentions connections:write scope', () => {
    const steps = getSlackAppSetupInstructions()
    const scopeStep = steps.find(s => s.includes('connections:write'))
    expect(scopeStep).toBeDefined()
  })
})
