import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// DISCORDLATHATO913: a paying customer wrote their own Discord plugin because
// ours was invisible -- first-class in the runtime and offered by the Linux
// installer, absent from the macOS menu and from every doc. These are
// structural anchors on the shipped files (the installer runs on a customer
// Mac where no harness can execute it end to end); each asserts one half of
// the parity, so a silent removal of any one fails the suite.

const ROOT = join(__dirname, '..', '..')
const MAC = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')
const LANG = readFileSync(join(ROOT, 'install-lang.sh'), 'utf-8')

describe('macOS installer offers Discord with Linux parity', () => {
  it('the menu has a third option and a discord branch', () => {
    expect(MAC).toContain('3.${NC} Discord')
    expect(MAC).toContain('CHANNEL_PROVIDER="discord"')
  })

  it('collects the same three credentials as the Linux path', () => {
    expect(MAC).toContain('prompt_discord_bot_token')
    expect(MAC).toContain('prompt_discord_channel_id')
    expect(MAC).toContain('prompt_discord_user_id')
  })

  it('persists them into the install .env', () => {
    expect(MAC).toContain('env_keep_or_set DISCORD_BOT_TOKEN')
    expect(MAC).toContain('env_keep_or_set DISCORD_CHANNEL_ID')
    expect(MAC).toContain('env_keep_or_set OPERATOR_DISCORD_USER_ID')
  })

  it('writes the channel dir env and a pairing access.json', () => {
    // The channel .env carries token + channel id only; the operator id lives
    // in the install .env -- the exact split the Linux path ships.
    expect(MAC).toMatch(/DISCORDENVEOF[\s\S]*DISCORD_CHANNEL_ID=\$DISCORD_CHANNEL_ID[\s\S]*DISCORDENVEOF/)
  })

  it('installs the official plugin', () => {
    expect(MAC).toContain('PLUGIN_ID="discord@claude-plugins-official"')
  })

  it('repairs a pre-existing managed allowlist that would silently mute discord', () => {
    // Measured on the fleet host: a managed-settings.json written by a
    // slack/teams install lists slack-channel+telegram+teams and BLOCKS every
    // plugin missing from it. A fresh telegram-only install never creates the
    // file, so the discord branch merges ONLY when the file already exists.
    const discordEntry = "'plugin': 'discord', 'marketplace': 'claude-plugins-official'"
    expect(MAC).toContain(discordEntry)
    // And the slack-branch REQUIRED_JSON now allowlists discord too, so a
    // later provider switch is not silently blocked.
    expect(MAC).toContain('"plugin":"discord","marketplace":"claude-plugins-official"')
  })

  it('the managed merge is atomic and never rebuilds the policy from scratch', () => {
    // Review condition (#1306): an in-place json.dump truncates the file
    // before writing, and a {} parse-failure fallback would re-create the org
    // policy with ONLY discord in it -- muting every other channel host-wide.
    // The shipped shape is the repo's safe merge: tmp + copymode + os.replace,
    // and on a parse failure it exits without writing.
    const block = MAC.slice(MAC.indexOf('DISCORDMERGEPY'), MAC.lastIndexOf('DISCORDMERGEPY'))
    expect(block).toContain('os.replace(tmp, p)')
    expect(block).toContain('shutil.copymode(p, tmp)')
    expect(block).toContain('NOT writing')
    expect(block).not.toContain("d = {}")
  })

  it('the bun advisory covers discord, not only telegram', () => {
    expect(MAC).toMatch(/"\$CHANNEL_PROVIDER" = "telegram" \] \|\| \[ "\$CHANNEL_PROVIDER" = "discord"/)
  })

  it('the shared lang file carries the macOS discord keys and a 3-way chooser', () => {
    expect(LANG).toContain('macos.discord_channel_configured')
    expect(LANG).toContain('(1/2/3)')
  })
})

describe('the docs stop hiding the Discord provider', () => {
  it('docs/channels.md names it in the title and has a specifics section', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'channels.md'), 'utf-8')
    expect(doc).toMatch(/^# Channels \(.*Discord.*\)/)
    expect(doc).toContain('### Discord-specifikum')
  })

  it('README offers Discord next to Telegram and Slack', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf-8')
    expect(readme).toContain('#### Discord (alternatív)')
    expect(readme).toContain('CHANNEL_PROVIDER=discord')
  })
})
