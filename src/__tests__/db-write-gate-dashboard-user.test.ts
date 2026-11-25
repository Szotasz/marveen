// DASHUSERGATE1123: the dashboard-user break-glass CLI's writing commands (reset-password, add, remove, totp:off,
// sessions:clear, security:reset) ask for no proof but being on the machine. From an agent session they are denied, for
// every agent; `list`, the bare call and the help pass, and so does reading the CLI's files. Nothing here runs the CLI.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, dashboardUserWrite } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
let agent: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dashuser-gate-')))
  root = join(base, 'Install')
  agent = join(root, 'agents', 'samu')
  mkdirSync(join(agent, '.claude-config'), { recursive: true })
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const DENY = { deny: true, reason: 'dashboard-user' }
const sub = (c: string) => gateDecision('Bash', { command: c }, { root, cwd: agent, subAgent: true, projectDir: agent, configDir: join(agent, '.claude-config') })
const main = (c: string) => gateDecision('Bash', { command: c }, { root, cwd: root, subAgent: false, projectDir: root, configDir: join(base, '.claude') })

const WRITES = [
  'npm run dashboard-user -- reset-password admin',
  "printf 'Xx123456789!' | npm run dashboard-user -- reset-password admin --password-stdin",
  "cd /x && printf 'Xx123456789!' | npm run dashboard-user -- add eve --password-stdin",
  'npm run dashboard-user -- remove admin',
  'npm run dashboard-user -- totp:off admin',
  'npm run dashboard-user -- security:reset',
  'npm run dashboard-user -- sessions:clear',
  'npm run dashboard-user -- sessions:clear admin',
  'npm --prefix /x run dashboard-user -- totp:off admin',
  'npm run-script dashboard-user -- totp:off admin',
  'npm run --silent dashboard-user -- totp:off admin',
  'pnpm dashboard-user totp:off admin',
  'yarn dashboard-user totp:off admin',
  'bun run dashboard-user totp:off admin',
  'npx tsx scripts/dashboard-user.ts totp:off admin',
  'tsx /abs/scripts/dashboard-user.ts reset-password admin',
  'node --import tsx scripts/dashboard-user.ts totp:off admin',
  'npx tsx src/dashboard-user-cli.ts totp:off admin',
  'node dist/dashboard-user-cli.js totp:off admin',
  'node /Users/x/ClaudeClaw/dist/dashboard-user-cli.js reset-password admin',
  './scripts/dashboard-user.ts totp:off admin',
  'docker compose exec marveen node dist/dashboard-user-cli.js totp:off admin',
  'docker exec -it m-marveen-1 node dist/dashboard-user-cli.js reset-password admin',
  "node dist/dashboard-user-cli.js 'totp:off' admin",
  'node dist/dashboard-user-cli.js "totp:off" admin',
  'env FOO=1 npm run dashboard-user -- totp:off admin',
  'timeout 30 npm run dashboard-user -- totp:off admin',
  'echo admin | xargs npm run dashboard-user -- totp:off',
  'V=totp:off; npm run dashboard-user -- $V admin',
  'npm run dashboard-user -- "$CMD" admin',
  "bash -c 'npm run dashboard-user -- totp:off admin'",
  'sh -c "node dist/dashboard-user-cli.js reset-password admin"',
  'echo $(npm run dashboard-user -- totp:off admin)',
  'echo `node dist/dashboard-user-cli.js totp:off admin`',
  'true; npm run dashboard-user -- totp:off admin',
  'npm run dashboard-user -- list && npm run dashboard-user -- totp:off admin',
]

const PASSES = [
  'npm run dashboard-user -- list',
  'npm run dashboard-user',
  'npm run dashboard-user -- --help',
  'node dist/dashboard-user-cli.js list',
  'docker compose exec marveen node dist/dashboard-user-cli.js list',
  'npx tsx scripts/dashboard-user.ts',
  'cat scripts/dashboard-user.ts',
  'grep -n totp:off src/dashboard-user-cli.ts docs/dashboard-auth-recovery.md',
  'sed -n 1,80p src/dashboard-user-cli.ts',
  'head -40 src/dashboard-user-cli.ts | tail -5',
  'git log -3 -- src/dashboard-user-cli.ts scripts/dashboard-user.ts',
  'git show HEAD:src/dashboard-user-cli.ts',
  'npx vitest run src/__tests__/dashboard-user-cli.test.ts',
  'npx tsc --noEmit -p tsconfig.json',
  'echo npm run dashboard-user -- totp:off admin',
  "gh pr create --title x --body 'run: npm run dashboard-user -- totp:off admin'",
  'cp src/dashboard-user-cli.ts /tmp/copy.ts',
  'npm run build',
  'npm run dashboard-user-report -- totp:off',
]

describe('dashboardUserWrite', () => {
  it('denies every writing command, in every spelling', () => {
    // shell code (bash -c / sh -c) is reached by decide()'s recursion, not by this function: see gateDecision below
    for (const c of WRITES.filter((w) => !/^(?:ba)?sh -c /.test(w))) expect([c, dashboardUserWrite(c)]).toEqual([c, true])
  })
  it('lets list, the bare call, the help and the readers pass', () => {
    for (const c of PASSES) expect([c, dashboardUserWrite(c)]).toEqual([c, false])
  })
})

describe('gateDecision: for every agent, the main agent too', () => {
  it('a sub-agent', () => {
    for (const c of WRITES) expect([c, sub(c)]).toEqual([c, DENY])
    for (const c of PASSES) expect([c, sub(c).reason === 'dashboard-user']).toEqual([c, false])
  })
  it('the main agent', () => {
    for (const c of WRITES) expect([c, main(c)]).toEqual([c, DENY])
    for (const c of PASSES) expect([c, main(c).reason === 'dashboard-user']).toEqual([c, false])
  })
})
