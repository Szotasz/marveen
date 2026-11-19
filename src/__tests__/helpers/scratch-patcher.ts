// The Telegram plugin patcher (scripts/patch-telegram-plugin.py) reads the install it sits in, the folder above
// scripts/: <install>/store/config-overrides.json and <install>/.env decide every setting no switch is given for
// (AGENT_TEXT_LANG, TELEGRAM_TOPICS_ENABLED, TELEGRAM_REPLY_BUTTONS, TELEGRAM_REPLY_BUTTONS_MAX_AGE_HOURS). Run from
// the checkout, a developer's own .env would decide a test (Geri on #2946 and #2949). This copy sits in an empty
// scratch install, so only what a test itself writes there counts.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const REPO_PATCHER = join(__dirname, '..', '..', '..', 'scripts', 'patch-telegram-plugin.py')

export function scratchPatcher(): { script: string; install: string; remove: () => void } {
  const install = mkdtempSync(join(tmpdir(), 'tg-patcher-install-'))
  mkdirSync(join(install, 'scripts'))
  const script = join(install, 'scripts', 'patch-telegram-plugin.py')
  copyFileSync(REPO_PATCHER, script)
  return { script, install, remove: () => rmSync(install, { recursive: true, force: true }) }
}
