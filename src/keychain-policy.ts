import { readEnvFile } from './env.js'
import { logger } from './logger.js'

// MARVEEN_NO_KEYCHAIN_READS=1 (in .env, or in the process environment, which wins): the unattended background
// paths (heartbeat tick, interactive worker pre-start, usage-collect.py) never call /usr/bin/security. From a
// launchd/tmux session the login Keychain is locked ("No keychain is available", exit 53), and every call can pop a
// macOS "enter the keychain password" dialog on the machine. With the switch on, those callers use their existing
// non-Keychain path (the fleet setup-token in store/.claude-oauth-token / CLAUDE_CODE_OAUTH_TOKEN) or return null,
// exactly as off macOS. Read on every call, so a .env change needs no restart. Any other value (unset, empty, 0)
// keeps today's behaviour. Interactive paths (onboarding, doctor.sh) are deliberately not covered: a human is there
// to answer the dialog.
export function keychainReadsDisabled(): boolean {
  const raw = process.env.MARVEEN_NO_KEYCHAIN_READS ?? readEnvFile(['MARVEEN_NO_KEYCHAIN_READS']).MARVEEN_NO_KEYCHAIN_READS ?? ''
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

const loggedFor = new Set<string>()

// True when the caller must skip its `security` call. Logs one INFO line per caller per process, never a value.
export function skipKeychainRead(caller: string): boolean {
  if (!keychainReadsDisabled()) return false
  if (!loggedFor.has(caller)) {
    loggedFor.add(caller)
    logger.info(`MARVEEN_NO_KEYCHAIN_READS=1: ${caller} skips the Keychain read (the macOS login Keychain is not touched)`)
  }
  return true
}
