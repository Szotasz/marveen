import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { homedir, platform } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

const ok = (msg: string) => console.log(`${GREEN}✓${RESET} ${msg}`)
const warn = (msg: string) => console.log(`${YELLOW}⚠${RESET} ${msg}`)
const fail = (msg: string) => console.log(`${RED}✗${RESET} ${msg}`)
const header = (msg: string) => console.log(`\n${BOLD}${msg}${RESET}\n`)

const rl = createInterface({ input: process.stdin, output: process.stdout })
function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${BOLD}${question}${RESET} `, (answer) => resolve(answer.trim()))
  })
}

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

async function main() {
  console.log(BANNER)
  header('Udvozol a Marveen telepito!')
  console.log('Ez a varazslo vegigvezet a beallitasokon.\n')

  // --- Kovetelmeny ellenorzes ---
  header('1. Kovetelmeny ellenorzes')

  // Node verzio
  const nodeVersion = process.version
  const major = parseInt(nodeVersion.slice(1), 10)
  if (major >= 20) {
    ok(`Node.js ${nodeVersion}`)
  } else {
    fail(`Node.js ${nodeVersion} — minimum 20 szukseges!`)
    process.exit(1)
  }

  // Claude CLI
  try {
    const claudeVersion = execSync('claude --version 2>/dev/null', { encoding: 'utf-8' }).trim()
    ok(`Claude CLI: ${claudeVersion}`)
  } catch {
    fail('Claude CLI nem talalhato. Telepitsd: npm install -g @anthropic-ai/claude-code')
    process.exit(1)
  }

  // Build
  header('2. Projekt epit')
  try {
    console.log('npm install futtatasa...')
    execSync('npm install', { cwd: PROJECT_ROOT, stdio: 'inherit' })
    ok('Fuggosegek telepitve')

    console.log('TypeScript forditas...')
    execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' })
    ok('Forditas sikeres')
  } catch {
    fail('Build hiba. Ellenorizd a hibauzenetet fentebb.')
    process.exit(1)
  }

  // --- Konfig gyujtes ---
  header('3. Konfiguracio')

  const envPath = join(PROJECT_ROOT, '.env')
  const config: Record<string, string> = {}

  // Channel provider selection
  console.log('\nMelyik csatorna-szolgaltatot hasznalod?')
  console.log('  1. Telegram (alapertelmezett)')
  console.log('  2. Slack\n')
  const providerChoice = await ask('Valassz (1/2, Enter = Telegram):')
  const provider = providerChoice === '2' ? 'slack' : 'telegram'
  config['CHANNEL_PROVIDER'] = provider
  ok(`Csatorna: ${provider}`)

  if (provider === 'telegram') {
    console.log('\nTelegram bot token szukseges.')
    console.log('Igy szerezhetsz egyet:')
    console.log('  1. Nyisd meg a Telegram-ot es keress ra: @BotFather')
    console.log('  2. Kuldj neki: /newbot')
    console.log('  3. Adj nevet es usernevet a botnak')
    console.log('  4. Masold ki a tokent amit kapsz\n')

    config['TELEGRAM_BOT_TOKEN'] = await ask('Telegram bot token:')
    if (!config['TELEGRAM_BOT_TOKEN']) {
      fail('Token szukseges!')
      process.exit(1)
    }
    ok('Token rogzitve')
  } else {
    console.log('\nSlack app tokenek szuksegesek.')
    console.log('  1. Hozz letre egy Slack App-ot: api.slack.com/apps')
    console.log('  2. Engedeld a Socket Mode-ot')
    console.log('  3. Adj hozza Bot Token Scopes: chat:write, channels:read, files:write')
    console.log('  4. Installald a workspace-be\n')

    config['SLACK_BOT_TOKEN'] = await ask('Bot Token (xoxb-...):')
    if (!config['SLACK_BOT_TOKEN']) {
      fail('Bot Token szukseges!')
      process.exit(1)
    }
    config['SLACK_APP_TOKEN'] = await ask('App-Level Token (xapp-...):')
    if (!config['SLACK_APP_TOKEN']) {
      fail('App Token szukseges!')
      process.exit(1)
    }
    ok('Slack tokenek rogzitve')
  }

  // ElevenLabs TTS
  console.log('\nElevenLabs TTS (szoveg-beszed) beallitas.')
  console.log('API kulcsot itt szerezhetsz: https://elevenlabs.io')
  const elKey = await ask('ElevenLabs API kulcs (Enter a kihagyashoz):')
  if (elKey) {
    config['ELEVENLABS_API_KEY'] = elKey
    const elVoice = await ask('ElevenLabs hang azonosito (Voice ID):')
    if (elVoice) config['ELEVENLABS_VOICE_ID'] = elVoice
    ok('ElevenLabs konfiguracio rogzitve')
  } else {
    warn('ElevenLabs kihagyva — hangos valaszok nem lesznek elerhetoek')
  }

  // DeepSeek-V4-Pro (alternativ modell a Claude mellett)
  console.log('\nDeepSeek-V4-Pro alternativ modell tamogatas (opcionalis).')
  console.log('A DeepSeek olcsobb mint a Claude, kompatibilis Anthropic API-t kinal,')
  console.log('1M token kontextussal. API kulcsot itt szerezhetsz: https://api.deepseek.com')
  const dsKey = await ask('DeepSeek API kulcs (Enter a kihagyashoz):')
  if (dsKey) {
    // Mentsuk a vault-ba (titkositott tarolas), nem a sima .env-be:
    // a kulcs igy a dashboard felulet rotacios kontrollja ala kerul es
    // nem jelenik meg a .env fajl tartalmaban hat hosszan.
    const { setSecret } = await import('../dist/web/vault.js')
    setSecret('DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY', dsKey)
    ok('DeepSeek API kulcs mentve a vault-ba (DEEPSEEK_API_KEY)')
    ok('A deepseek-v4-pro modell most mar elerheto agensekhez')
  } else {
    warn('DeepSeek kihagyva — kesobb a dashboard /vault oldalrol hozzaadhato')
  }

  // .env iras
  header('4. .env fajl irasa')
  let envContent = '# Marveen konfiguracio\n'
  for (const [key, value] of Object.entries(config)) {
    envContent += `${key}=${value}\n`
  }
  writeFileSync(envPath, envContent, { mode: 0o600 })
  ok('.env fajl letrehozva (0600)')

  // CLAUDE.md szerkesztes
  header('5. CLAUDE.md testreszabas')
  const editor = process.env.EDITOR ?? 'nano'
  console.log(`Megnyitom a CLAUDE.md fajlt szerkesztesre (${editor})...`)
  console.log('Csereld ki a [NAGYBETUS] helyorzokat a sajat adataiddal.\n')

  const editNow = await ask('Szerkeszted most? (i/n):')
  if (editNow.toLowerCase() === 'i' || editNow.toLowerCase() === 'igen') {
    spawnSync(editor, [join(PROJECT_ROOT, 'CLAUDE.md')], { stdio: 'inherit' })
    ok('CLAUDE.md szerkesztve')
  } else {
    warn('CLAUDE.md kesobb is szerkesztheto')
  }

  // Hatterszolgaltatas
  header('6. Hatterszolgaltatas telepites')
  const os = platform()

  if (os === 'darwin') {
    const installService = await ask('Telepited hatterszolgaltatasnak? (i/n):')
    if (installService.toLowerCase() === 'i' || installService.toLowerCase() === 'igen') {
      const plistName = 'com.claudeclaw.app'
      const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${plistName}.plist`)
      const nodePath = execSync('which node', { encoding: 'utf-8' }).trim()

      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistName}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${join(PROJECT_ROOT, 'dist', 'index.js')}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/tmp/claudeclaw.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/claudeclaw.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>`

      writeFileSync(plistPath, plist)
      try {
        execSync(`launchctl unload ${plistPath} 2>/dev/null`, { stdio: 'ignore' })
      } catch {
        // ha nincs betöltve, nem baj
      }
      execSync(`launchctl load ${plistPath}`)
      ok(`Hatterszolgaltatas telepitve: ${plistPath}`)
      ok('Automatikusan indul a gep bekapcsolasakor')
      console.log(`  Naplo: tail -f /tmp/claudeclaw.log`)
      console.log(`  Leallitas: launchctl unload ${plistPath}`)
    }
  } else if (os === 'linux') {
    const installService = await ask('Telepited systemd szolgaltatasnak? (i/n):')
    if (installService.toLowerCase() === 'i' || installService.toLowerCase() === 'igen') {
      const nodePath = execSync('which node', { encoding: 'utf-8' }).trim()
      const serviceDir = join(homedir(), '.config', 'systemd', 'user')
      execSync(`mkdir -p ${serviceDir}`)
      const servicePath = join(serviceDir, 'claudeclaw.service')

      const service = `[Unit]
Description=Marveen AI Asszisztens
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${join(PROJECT_ROOT, 'dist', 'index.js')}
WorkingDirectory=${PROJECT_ROOT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target`

      writeFileSync(servicePath, service)
      execSync('systemctl --user daemon-reload')
      execSync('systemctl --user enable claudeclaw')
      execSync('systemctl --user start claudeclaw')
      ok('Systemd szolgaltatas telepitve es elindítva')
      console.log('  Allapot: systemctl --user status claudeclaw')
      console.log('  Naplo: journalctl --user -u claudeclaw -f')
    }
  } else {
    warn('Windows: hasznald a PM2-t a hatterszolgaltatashoz:')
    console.log('  npm install -g pm2')
    console.log(`  pm2 start ${join(PROJECT_ROOT, 'dist', 'index.js')} --name claudeclaw`)
    console.log('  pm2 save && pm2 startup')
  }

  // Chat/Channel ID
  header('7. Chat azonosito')
  if (provider === 'telegram') {
    console.log('Ha mar fut a bot, kuldj neki /chatid uzenetet a Telegram-on.')
    console.log('A bot visszaküldi a chat azonositodat.')
  } else {
    console.log('Add meg a Slack channel ID-t ahova a bot irhat.')
    console.log('(Jobb klikk a csatornan -> "Copy channel ID")')
  }
  const chatIdLabel = provider === 'telegram' ? 'ALLOWED_CHAT_ID' : 'SLACK_CHANNEL_ID'
  const chatId = await ask(`${chatIdLabel} (Enter a kihagyashoz, kesobb is megadhatod):`)
  if (chatId) {
    let envData = readFileSync(envPath, 'utf-8')
    envData += `${chatIdLabel}=${chatId}\n`
    writeFileSync(envPath, envData)
    ok(`${chatIdLabel} mentve: ${chatId}`)
  } else {
    warn(`${chatIdLabel} kesobb megadhato a .env fajlban`)
  }

  // Kész
  header('Kesz!')
  ok('Marveen sikeresen telepitve!')
  console.log('')
  console.log('Kovetkezo lepesek:')
  console.log(`  1. Ha nem adtad meg a chat ID-t: kuldj /chatid-t a botnak`)
  console.log(`  2. Nyisd meg a CLAUDE.md-t es toltsd ki a szemelyes adatokat`)
  console.log(`  3. Uzengess a botnak a Telegram-on!`)
  console.log('')
  console.log('Hasznos parancsok:')
  console.log('  npm run dev     — fejlesztoi mod (azonnali ujratöltés)')
  console.log('  npm run status  — allapot ellenorzes')
  console.log('  npm run build   — TypeScript forditas')
  console.log('')

  rl.close()
}

main().catch((err) => {
  console.error('Telepitesi hiba:', err)
  rl.close()
  process.exit(1)
})
