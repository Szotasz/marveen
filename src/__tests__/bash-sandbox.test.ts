// BASHSANDBOX1022 (kanban 79f60a8a): the per-agent Claude Code Bash sandbox settings, and the launch
// paths that must carry them. The settings keys are pinned exactly: each one answers a measurement
// (see bash-sandbox.ts), and dropping any of them reopens a measured hole -- strictAllowlist (bypass
// mode auto-approves a new host), allowUnsandboxedCommands:false (dangerouslyDisableSandbox walked
// out without a prompt), the --settings file (a project settings file switched the sandbox off).
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-bash-sandbox-test-'))
const STORE = join(tmpRoot, 'store')
mkdirSync(STORE, { recursive: true })
afterAll(() => { execFileSync('chmod', ['-R', 'u+w', tmpRoot]); rmSync(tmpRoot, { recursive: true, force: true }) })

vi.mock('../config.js', () => ({ STORE_DIR: STORE, PROJECT_ROOT: tmpRoot, MAIN_AGENT_ID: 'marveen' }))
const settings: Record<string, string> = {}
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: (k: string) => settings[k] ?? '' }))
vi.mock('../web/agent-config.js', () => ({ agentDir: (n: string) => join(tmpRoot, 'agents', n) }))

const {
  parseSandboxAgents, bashSandboxEnabledFor, sandboxAllowedDomains, sandboxWritePaths,
  buildBashSandboxSettings, syncBashSandboxSettings, bashSandboxSettingsPath, recordDashboardNode,
} = await import('../web/bash-sandbox.js')

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

beforeEach(() => { for (const k of Object.keys(settings)) delete settings[k] })

describe('BASH_SANDBOX_AGENTS', () => {
  it('is off by default: nobody is sandboxed', () => {
    expect(bashSandboxEnabledFor('soma')).toBe(false)
  })
  it('takes ids separated by commas or spaces, lower-cases them, and never the main agent', () => {
    expect([...parseSandboxAgents(' Soma, neo  trinity,,')].sort()).toEqual(['neo', 'soma', 'trinity'])
    expect([...parseSandboxAgents('marveen soma')]).toEqual(['soma'])
    expect([...parseSandboxAgents('../x soma $(id)')]).toEqual(['soma'])
    settings.BASH_SANDBOX_AGENTS = 'soma'
    expect(bashSandboxEnabledFor('soma')).toBe(true)
    expect(bashSandboxEnabledFor('neo')).toBe(false)
  })
})

describe('allowedDomains from store/egress-vendor-hosts.json', () => {
  const f = join(tmpRoot, 'vendor.json')
  it('hosts exactly, domains as themselves and *.domain, anything else dropped', () => {
    writeFileSync(f, JSON.stringify({ hosts: ['api.elevenlabs.io', '1.2.3.4', '*.x.com', 'a.b.io:443'], domains: ['dentalsalon.hu', '.bad.hu'] }))
    expect(sandboxAllowedDomains(f)).toEqual(['*.dentalsalon.hu', 'api.elevenlabs.io', 'dentalsalon.hu'])
  })
  it('a missing file is an empty list (strictAllowlist then denies every external host)', () => {
    expect(sandboxAllowedDomains(join(tmpRoot, 'nope.json'))).toEqual([])
  })
  it('a corrupt file throws, so the start is refused instead of guessing', () => {
    writeFileSync(f, '{not json')
    expect(() => sandboxAllowedDomains(f)).toThrow()
    writeFileSync(f, '[]')
    expect(() => sandboxAllowedDomains(f)).toThrow(/not a JSON object/)
  })
})

describe('allowWrite', () => {
  const f = join(tmpRoot, 'paths.json')
  it('the agent dir and its worktree root by default, plus the owner-listed absolute paths', () => {
    writeFileSync(f, JSON.stringify({ agents: { soma: ['~/Library/x/ai-reports', '/abs/out', 'relative/no', '/', '~/', 7], neo: ['/other'] } }))
    expect(sandboxWritePaths('soma', f, '/Users/u')).toEqual([
      join(tmpRoot, 'agents', 'soma'), '/Users/u/worktrees/soma', '/Users/u/Library/x/ai-reports', '/abs/out',
    ])
  })
})

describe('the settings block', () => {
  it('pins every measured key', () => {
    expect(buildBashSandboxSettings(['dentalsalon.hu'], ['/w'])).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        network: { strictAllowlist: true, allowLocalBinding: true, allowedDomains: ['dentalsalon.hu'] },
        filesystem: { allowWrite: ['/w'] },
      },
    })
  })
})

describe('syncBashSandboxSettings', () => {
  const dir = join(tmpRoot, 'bash-sandbox')
  const vendor = join(tmpRoot, 'v2.json')
  it('writes the file for a listed agent and removes it when the agent is taken off', () => {
    writeFileSync(vendor, JSON.stringify({ domains: ['dentalsalon.hu'] }))
    const p = syncBashSandboxSettings('soma', { dir, vendorPath: vendor, writePathsPath: join(tmpRoot, 'none.json'), enabled: true })
    expect(p).toBe(bashSandboxSettingsPath('soma', dir))
    const written = JSON.parse(readFileSync(p as string, 'utf-8'))
    expect(written.sandbox.network.allowedDomains).toEqual(['*.dentalsalon.hu', 'dentalsalon.hu'])
    expect(written.sandbox.network.strictAllowlist).toBe(true)
    // read-only between writes: the dir 0555, the file 0444; a rewrite still works
    expect(statSync(dir).mode & 0o777).toBe(0o555)
    expect(statSync(p as string).mode & 0o777).toBe(0o444)
    expect(syncBashSandboxSettings('soma', { dir, vendorPath: vendor, writePathsPath: join(tmpRoot, 'none.json'), enabled: true })).toBe(p)
    expect(() => writeFileSync(join(dir, 'planted.json'), '{}')).toThrow(/EACCES/)
    expect(syncBashSandboxSettings('soma', { dir, enabled: false })).toBeNull()
    expect(existsSync(p as string)).toBe(false)
    expect(statSync(dir).mode & 0o777).toBe(0o555)
  })
  it('an unlisted name the switch could never hold does not throw (the start is not blocked)', () => {
    expect(syncBashSandboxSettings('Weird Name', { dir, enabled: false })).toBeNull()
  })
  it('a listed agent with a corrupt vendor file throws (the caller refuses the start)', () => {
    writeFileSync(vendor, '{')
    expect(() => syncBashSandboxSettings('soma', { dir, vendorPath: vendor, enabled: true })).toThrow()
  })
})

// WDSANDBOXNODE1119: the dashboard records the node it runs on for scripts/watchdog.sh, whose PATH may not hold it
// (nvm). The full watchdog side is scripts/__tests__/watchdog-bash-sandbox.test.sh.
describe('recordDashboardNode', () => {
  const dir = join(tmpRoot, 'node-rec')
  const file = join(dir, '.dashboard-node')
  it('writes the path and one newline, read-only; leaves the directory as it was; rewrites only on a change', () => {
    mkdirSync(dir, { recursive: true })
    const dirMode = statSync(dir).mode & 0o777
    expect(recordDashboardNode('/opt/x/bin/node', file)).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe('/opt/x/bin/node\n')
    expect(statSync(file).mode & 0o777).toBe(0o444)
    expect(statSync(dir).mode & 0o777).toBe(dirMode)
    const before = statSync(file).ino
    expect(recordDashboardNode('/opt/x/bin/node', file)).toBe(false)
    expect(statSync(file).ino).toBe(before)
    expect(recordDashboardNode('/home/u/.nvm/versions/node/v22/bin/node', file)).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe('/home/u/.nvm/versions/node/v22/bin/node\n')
    expect(statSync(file).mode & 0o777).toBe(0o444)
  })
  // Dani 81206 B1: a 0555 store/bash-sandbox/ on every install left a stage directory scripts/backup.sh could not
  // remove. The default is a file directly in the store, and the dashboard's start (this, then the sandbox sync of an
  // agent the owner's list does not name) creates no store/bash-sandbox/ on an install without the list.
  it('defaults to this process\'s own node, in store/.dashboard-node; no store/bash-sandbox/ without the list', () => {
    const sb = join(STORE, 'bash-sandbox')
    expect(existsSync(sb)).toBe(false)
    recordDashboardNode()
    expect(readFileSync(join(STORE, '.dashboard-node'), 'utf-8')).toBe(`${process.execPath}\n`)
    expect(statSync(join(STORE, '.dashboard-node')).mode & 0o777).toBe(0o444)
    expect(syncBashSandboxSettings('soma')).toBeNull()
    expect(existsSync(sb)).toBe(false)
  })
  it('the dashboard records it at start, before the first agent start', () => {
    const idx = readFileSync(join(REPO, 'src', 'index.ts'), 'utf-8')
    const main = idx.slice(idx.indexOf('async function main()'))
    expect(main).toMatch(/if \(recordDashboardNode\(\)\) logger\.info/)
    expect(main.indexOf('recordDashboardNode()')).toBeLessThan(main.indexOf('startAgentProcess('))
    const src = readFileSync(join(REPO, 'src', 'web', 'bash-sandbox.ts'), 'utf-8')
    expect(src).toMatch(/export const DASHBOARD_NODE_PATH = join\(STORE_DIR, '\.dashboard-node'\)/)
    expect(src).toMatch(/recordDashboardNode\(execPath = process\.execPath, file = DASHBOARD_NODE_PATH\)/)
    const wd = readFileSync(join(REPO, 'scripts', 'watchdog.sh'), 'utf-8')
    expect(wd).toMatch(/local F="\$INSTALL_DIR\/store\/\.dashboard-node"/)
  })
})

// startAgentProcess is too wide to run here; its sandbox contract is pinned on the source, like
// writeMainModel's guard (model-id-injection.test.ts).
describe('the launch paths carry the file', () => {
  const src = readFileSync(join(REPO, 'src', 'web', 'agent-process.ts'), 'utf-8')
  it('agent-process: the --settings flag is on the launch command, and a failure refuses the start', () => {
    expect(src).toMatch(/\$\{worksourceFlags\}\$\{bashSandboxFlag\}`\.trimEnd\(\)/)
    expect(src).toMatch(/bashSandboxFlag = ` --settings \$\{shSingleQuote\(sandboxFile\)\}`/)
    const block = src.slice(src.indexOf('let bashSandboxFlag'), src.indexOf("bash-sandbox: agent NOT started (fail-closed"))
    // The switch itself (Szotasz, #2149 review): the file the flag names must come from the sync call
    // for THIS agent, and the flag must be set from it. Without this pin, replacing the call with null
    // left every other test green and the agent started unsandboxed.
    expect(block).toMatch(/const sandboxFile = syncBashSandboxSettings\(name\)\n\s*if \(sandboxFile\) \{[\s\S]*?bashSandboxFlag = ` --settings \$\{shSingleQuote\(sandboxFile\)\}`/)
    expect(block.match(/sandboxFile =/g)).toHaveLength(1)
    expect(block).toMatch(/if \(sandboxFile\) \{\s*if \(remote\.host && remote\.workdir\) \{\s*logger\.error\([^\n]*\n\s*return \{ ok: false, error: 'bash-sandbox: a remote agent cannot be sandboxed/)
    // a failure to write the file refuses the start, it does not start the agent unsandboxed
    expect(src).toMatch(/could not be written\)'\)\s*\n\s*return \{ ok: false, error: `bash-sandbox: /)
    // decided before the remote branch returns, so a remote agent cannot skip it
    expect(src.indexOf('let bashSandboxFlag')).toBeLessThan(src.indexOf('return startRemoteAgentProcess('))
  })

  // WDSANDBOXMARKER1119: the restart no longer decides by the file on disk (deleted -> unsandboxed, edited -> passed
  // on). It produces the file through the dashboard's own sync, and a listed agent it cannot produce one for is not
  // started. The full run is scripts/__tests__/watchdog-bash-sandbox.test.sh (real dist, stubbed tmux); here the
  // --sandbox-flag hook with a stand-in helper, and the wiring on the source.
  it('watchdog.sh: the flag is the helper\'s answer, and anything else refuses', () => {
    const fx = join(tmpRoot, 'wd')
    mkdirSync(join(fx, 'scripts'), { recursive: true })
    mkdirSync(join(fx, 'store', 'bash-sandbox'), { recursive: true })
    writeFileSync(join(fx, 'scripts', 'watchdog.sh'), readFileSync(join(REPO, 'scripts', 'watchdog.sh')))
    const file = join(fx, 'store', 'bash-sandbox', 'soma.settings.json')
    const helper = (body: string) => writeFileSync(join(fx, 'scripts', 'bash-sandbox-sync.mjs'), body)
    const run = (id: string) => execFileSync('bash', [join(fx, 'scripts', 'watchdog.sh'), '--sandbox-flag', id], { encoding: 'utf-8' }).trim()
    // a file on disk without the helper's word is not enough any more
    writeFileSync(file, '{}')
    helper('process.exit(1)\n')
    expect(run('soma')).toBe('flag=REFUSED')
    helper('process.stdout.write("settings=\\n")\n')
    expect(run('soma')).toBe('flag=')
    helper(`process.stdout.write(${JSON.stringify(`settings=${file}\n`)})\n`)
    expect(run('soma')).toBe(`flag= --settings '${file}'`)
    // another agent's file, a quote, a second line, or no answer at all: refused
    expect(run('zara')).toBe('flag=REFUSED')
    // (each of these still ends in the right file name, so only the quote and line checks refuse them)
    helper(`process.stdout.write(${JSON.stringify(`settings=${join(fx, "it's", 'store', 'bash-sandbox', 'soma.settings.json')}\n`)})\n`)
    expect(run('soma')).toBe('flag=REFUSED')
    helper(`process.stdout.write(${JSON.stringify(`settings=/x\nsettings=${file}\n`)})\n`)
    expect(run('soma')).toBe('flag=REFUSED')
    helper(`process.stdout.write(${JSON.stringify(`noise\nsettings=${file}\n`)})\n`)
    expect(run('soma')).toBe('flag=REFUSED')
    helper('\n')
    expect(run('soma')).toBe('flag=REFUSED')
  })
  it('watchdog.sh: the restart refuses before building the command, and the command carries the produced flag', () => {
    const wd = readFileSync(join(REPO, 'scripts', 'watchdog.sh'), 'utf-8')
    expect(wd).not.toMatch(/if \[ -f "\$F" \]; then printf " --settings/)
    expect(wd).toMatch(/NODE="\$\(dashboard_node\)"\n\s*\[ -n "\$NODE" \] \|\| return 1\n\s*OUT="\$\("\$NODE" "\$INSTALL_DIR\/scripts\/bash-sandbox-sync\.mjs" "\$1" 2>>"\$LOG"\)" \|\| return 1/)
    const loop = wd.slice(wd.indexOf('for AGENT_DIR in'))
    expect(loop).toMatch(/if ! SANDBOX_FLAG="\$\(agent_sandbox_flag "\$AGENT_ID"\)"; then\n\s*echo "[^\n]*not started: bash-sandbox settings could not be produced[^\n]*\n\s*continue\n\s*fi/)
    expect(loop.indexOf('if ! SANDBOX_FLAG=')).toBeLessThan(loop.indexOf('CMD="'))
    expect(loop).toMatch(/--channels plugin:\$\{AGENT_PROVIDER\}@claude-plugins-official\$\{SANDBOX_FLAG\}"/)
    expect(loop.match(/agent_sandbox_flag/g)).toHaveLength(1)
  })
  it('the helper is the dashboard\'s own sync, not a copy of the rule', () => {
    const helperSrc = readFileSync(join(REPO, 'scripts', 'bash-sandbox-sync.mjs'), 'utf-8')
    expect(helperSrc).toMatch(/await import\(join\(projectRoot, 'dist', 'web', 'bash-sandbox\.js'\)\)/)
    expect(helperSrc).toMatch(/const file = syncBashSandboxSettings\(String\(process\.argv\[2\] \?\? ''\)\)\n\s*process\.stdout\.write\(`settings=\$\{file \?\? ''\}\\n`\)/)
    expect(helperSrc).toMatch(/process\.exit\(1\)/)
    expect(helperSrc).not.toMatch(/BASH_SANDBOX_AGENTS['"]/)
  })
})
