import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readMarveenTelegramConfig } from '../web/telegram.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// hu: A fo ugynok csatorna-allapotanak elkulonitese (channelStateDir) csak akkor
//     ER valamit, ha MINDEN olvaso ugyanazt a feloldast hasznalja. Egy megmaradt
//     fix $HOME/.claude/channels/telegram ut azt jelenti, hogy az adott komponens
//     a MASIK telepites bot-tokenjet olvassa -- a Jarvis dashboardja a Marveen
//     bot-jat jelentene csatlakozottnak, a Jarvis bot-menuje a Marveen bot-jara
//     kerulne.
// en: Isolating the main agent's channel state only pays off if EVERY reader
//     resolves it the same way. A leftover fixed $HOME path means that component
//     reads the OTHER install's bot token.
describe('channelStateDir testverek: minden olvaso a feloldott konyvtarat hasznalja', () => {
  const dirs: string[] = []
  const savedEnv = process.env['TELEGRAM_STATE_DIR']

  afterEach(() => {
    if (savedEnv === undefined) delete process.env['TELEGRAM_STATE_DIR']
    else process.env['TELEGRAM_STATE_DIR'] = savedEnv
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function sandboxStateDir(token: string): string {
    const root = mkdtempSync(join(tmpdir(), 'chan-state-'))
    dirs.push(root)
    const stateDir = join(root, 'telegram-testinstall')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, '.env'), `TELEGRAM_BOT_TOKEN=${token}\n`)
    return stateDir
  }

  it('readMarveenTelegramConfig a sajat telepites STATE_DIR-jebol olvas', () => {
    process.env['TELEGRAM_STATE_DIR'] = sandboxStateDir('111111:SAJAT-TOKEN')
    expect(readMarveenTelegramConfig().hasTelegram).toBe(true)
  })

  it('ures STATE_DIR-nel nem talal tokent -- nem esik vissza a masik telepitesere', () => {
    const root = mkdtempSync(join(tmpdir(), 'chan-state-'))
    dirs.push(root)
    const empty = join(root, 'telegram-ures')
    mkdirSync(empty, { recursive: true })
    process.env['TELEGRAM_STATE_DIR'] = empty
    expect(readMarveenTelegramConfig().hasTelegram).toBe(false)
  })

  // A maradek ket testver statikusan: a fix homedir()-ut, illetve a fix $HOME-ut
  // eltunese a bizonyitek, hogy a feloldason mennek keresztul.
  it('a scheduler riasztas-tokenje nem fix homedir()-utrol jon', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'web', 'schedule-runner.ts'), 'utf-8')
    const fn = src.slice(src.indexOf('function resolveSchedulerAlertToken'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).not.toContain(`homedir(), '.claude', 'channels'`)
    expect(body).toContain('channelStateDir(')
  })

  it('a set-bot-menu.sh a STATE_DIR-t tiszteli', () => {
    const sh = readFileSync(join(REPO_ROOT, 'scripts', 'set-bot-menu.sh'), 'utf-8')
    expect(sh).toContain('TELEGRAM_STATE_DIR')
    expect(sh).not.toContain('$HOME/.claude/channels/telegram/.env')
  })

  it('a telegram.ts fo-ugynok olvasoi nem drotozzak be a homedir() utat', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'web', 'telegram.ts'), 'utf-8')
    expect(src).not.toContain(`join(homedir(), '.claude', 'channels'`)
  })

  it('a homedir() alapertelmezes maga megmarad a feloldoban (visszafele kompatibilitas)', () => {
    delete process.env['TELEGRAM_STATE_DIR']
    const src = readFileSync(join(REPO_ROOT, 'src', 'channel-provider.ts'), 'utf-8')
    expect(src).toContain(`join(homedir(), '.claude', 'channels')`)
    expect(homedir()).toBeTruthy()
  })
})
