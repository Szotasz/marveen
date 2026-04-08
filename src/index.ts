import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR, WEB_PORT, ALLOWED_CHAT_ID } from './config.js'
import { initDatabase } from './db.js'
import { runDecaySweep, runDailyDigest } from './memory.js'
import { initHeartbeat, stopHeartbeat } from './heartbeat.js'
import { startWebServer } from './web.js'
import { logger } from './logger.js'

const BANNER = `
 ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝╚══════╝
 ██████╗██╗      █████╗ ██╗    ██╗
██╔════╝██║     ██╔══██╗██║    ██║
██║     ██║     ███████║██║ █╗ ██║
██║     ██║     ██╔══██║██║███╗██║
╚██████╗███████╗██║  ██║╚███╔███╔╝
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝  (lite)
`

const PID_FILE = join(STORE_DIR, 'claudeclaw.pid')

function acquireLock(): void {
  mkdirSync(STORE_DIR, { recursive: true })

  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
    if (oldPid) {
      try {
        process.kill(oldPid, 0)
        logger.warn({ oldPid }, 'Korabbi peldany megallitasa...')
        process.kill(oldPid, 'SIGTERM')
      } catch {
        // nem fut már, rendben
      }
    }
  }

  writeFileSync(PID_FILE, String(process.pid))
  logger.info({ pid: process.pid }, 'Zarolasi fajl letrehozva')
}

function releaseLock(): void {
  try {
    unlinkSync(PID_FILE)
  } catch {
    // ignorálható
  }
}

async function main(): Promise<void> {
  console.log(BANNER)

  acquireLock()

  // Database
  initDatabase()
  logger.info('Adatbazis inicializalva')

  // Memory decay (24h cycle)
  runDecaySweep()
  const decayInterval = setInterval(runDecaySweep, 24 * 60 * 60 * 1000)
  logger.info('Memoria leepulesi ciklus beallitva (24 oras)')

  // Daily digest at 23:00
  function scheduleDailyDigest() {
    const now = new Date()
    const target = new Date(now)
    target.setHours(23, 0, 0, 0)
    if (target <= now) target.setDate(target.getDate() + 1)
    const msUntil = target.getTime() - now.getTime()
    setTimeout(() => {
      runDailyDigest(ALLOWED_CHAT_ID).catch((err) =>
        logger.error({ err }, 'Napi naplo hiba')
      )
      setInterval(() => {
        runDailyDigest(ALLOWED_CHAT_ID).catch((err) =>
          logger.error({ err }, 'Napi naplo hiba')
        )
      }, 24 * 60 * 60 * 1000)
    }, msUntil)
    logger.info({ nextRun: target.toLocaleString('hu-HU') }, 'Napi naplo utemezve')
  }
  scheduleDailyDigest()

  // Heartbeat
  initHeartbeat()
  logger.info('Heartbeat utemezo elindult')

  // Web dashboard
  const webServer = startWebServer(WEB_PORT)

  // Shutdown handlers
  const shutdown = () => {
    logger.info('Leallitas...')
    stopHeartbeat()
    clearInterval(decayInterval)
    webServer.close()
    releaseLock()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  logger.info(`ClaudeClaw Lite fut! Dashboard: http://localhost:${WEB_PORT}`)
  logger.info('Telegram kommunikacio: Claude Code Channels kezeli')
}

main().catch((err) => {
  logger.error({ err }, 'Vegzetes hiba')
  releaseLock()
  process.exit(1)
})
