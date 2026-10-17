import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMainSessionRespawnCmd } from '../web/channel-monitor.js'
// Reporting-free factory on purpose: these cases are about the launch STRING.
import { mainConfigDecisionForTest } from '../web/main-config-decision.js'

// MAINOWNLOGIN1008. The main agent's own-credential modes -- an explicit
// MAIN_AGENT_CONFIG_DIR, or a configDir-mode rotated claude-plans entry -- point
// CLAUDE_CONFIG_DIR at a dir with its OWN .credentials.json. Every launcher took
// care not to EXPORT the fleet token for them, but none of them took it AWAY:
// channels.sh exports it at the top and sources it into the pane first
// (AUTH_PANE_ENV), and the tmux server's global env carries it into every
// respawn-pane. An env CLAUDE_CODE_OAUTH_TOKEN beats the dir's login, so the
// "own login" silently ran on the inference-only fleet token. Measured
// 2026-10-08 on the main host: /remote-control answered "Remote Control requires
// a full-scope login token". These tests EXECUTE the launch prefixes with a
// token already in the environment, so they check what the launched process
// actually sees, not just the words in the string.

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(__dirname, '..', '..', 'scripts')
const SHELL_LAUNCHERS = ['channels.sh', 'channel-watchdog.sh', 'stuck-modal-guard.sh'] as const
const INHERITED = 'inherited-fleet-token-fixture'
const FIXTURE_FILE_TOKEN = 'fleet-file-token-fixture'

let tmp = ''
let probe = ''
let installDir = ''

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'main-own-login-'))
  // Stands in for `claude`: prints what it was handed, never starts a session.
  probe = join(tmp, 'probe.sh')
  writeFileSync(probe, '#!/bin/sh\nprintf "token=%s dir=%s" "${CLAUDE_CODE_OAUTH_TOKEN-UNSET}" "${CLAUDE_CONFIG_DIR-UNSET}"\n')
  chmodSync(probe, 0o755)
  installDir = join(tmp, 'install')
  mkdirSync(join(installDir, 'store'), { recursive: true })
  writeFileSync(join(installDir, 'store', '.claude-oauth-token'), FIXTURE_FILE_TOKEN)
})

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

/** Run `cmd` in a shell whose environment already carries a fleet token, the
 *  way a respawn-pane inherits the tmux server's global env. */
function runWithInheritedToken(cmd: string): string {
  return execFileSync('bash', ['-c', cmd], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmp, CLAUDE_CODE_OAUTH_TOKEN: INHERITED },
    encoding: 'utf-8',
  })
}

/** The CFG_ENV assignment a launcher makes for one helper mode, lifted verbatim
 *  out of the script: the first `CFG_ENV="..."` line inside the branch that
 *  `branchHead` opens. */
function cfgEnvLine(src: string, branchHead: RegExp): string {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => branchHead.test(l))
  if (start < 0) throw new Error(`branch not found: ${branchHead}`)
  const line = lines.slice(start + 1).find((l) => /^\s*CFG_ENV="/.test(l))
  if (!line) throw new Error(`no CFG_ENV assignment after ${branchHead}`)
  return line.trim()
}

/** Evaluate the script's own CFG_ENV assignment for a dir, then launch the
 *  probe behind it -- after an AUTH_PANE_ENV-style export, as channels.sh does. */
function launchThroughShellCfgEnv(assignment: string, cfgDir: string): string {
  const script = [
    `sh_single_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }`,
    `INSTALL_DIR=${JSON.stringify(installDir)}`,
    `_cfg_dir=${JSON.stringify(cfgDir)}`,
    assignment,
    `bash -c "export CLAUDE_CODE_OAUTH_TOKEN=${INHERITED} && \${CFG_ENV}${probe}"`,
  ].join('\n')
  return runWithInheritedToken(script)
}

const OWN_BRANCH = /if \[ "\$_cfg_mode" = "explicit" \] \|\| \[ "\$_cfg_mode" = "rotated" \]; then/
const ISOLATED_BRANCH = /^\s*else\s*$/

describe('own-credential main launches carry NO fleet token (MAINOWNLOGIN1008)', () => {
  describe.each(SHELL_LAUNCHERS)('%s', (name) => {
    const src = () => readFileSync(join(SCRIPTS, name), 'utf-8')

    it('explicit/rotated: the launched process sees the own dir and NO token, even with one inherited', () => {
      const out = launchThroughShellCfgEnv(cfgEnvLine(src(), OWN_BRANCH), '/home/op/.claude-main')
      expect(out).toBe('token=UNSET dir=/home/op/.claude-main')
    })

    it('POSITIVE CONTROL: the plain isolated branch still hands the process the fleet token from the file', () => {
      // Lifted from the `else` that follows the token-mode branch, so a mistaken
      // unset that leaked into the isolated mode would fail here.
      const s = src()
      const tokenIdx = s.indexOf('elif [ "$_cfg_mode" = "token" ]; then')
      expect(tokenIdx).toBeGreaterThan(-1)
      const line = cfgEnvLine(s.slice(tokenIdx).split('\n').slice(1).join('\n'), ISOLATED_BRANCH)
      const out = launchThroughShellCfgEnv(line, '/srv/m/.channels-config')
      expect(out).toBe(`token=${FIXTURE_FILE_TOKEN} dir=/srv/m/.channels-config`)
    })
  })

  describe('buildMainSessionRespawnCmd (watchdog / keep-alive / hard-restart / reauth respawns)', () => {
    const base = {
      claudePath: '',
      pluginId: 'telegram@claude-plugins-official',
      model: '',
      continueSession: false,
      channelStateEnv: { name: 'TELEGRAM_STATE_DIR', dir: '/opt/marveen/.claude/channels/telegram' },
    }

    it('ownCredentials: the respawned process sees the own dir and NO token, even with one in the tmux env', () => {
      const cmd = buildMainSessionRespawnCmd({
        ...base,
        claudePath: probe,
        config: mainConfigDecisionForTest({ isolatedConfigDir: '/home/op/.claude-main', ownCredentials: true, fleetToken: true }),
      })
      expect(runWithInheritedToken(cmd)).toBe('token=UNSET dir=/home/op/.claude-main')
    })

    it('POSITIVE CONTROL: the plain isolated dir still exports the fleet token', () => {
      const cmd = buildMainSessionRespawnCmd({
        ...base,
        claudePath: probe,
        config: mainConfigDecisionForTest({ isolatedConfigDir: '/srv/m/.channels-config', fleetToken: true }),
      })
      expect(cmd).toContain('export CLAUDE_CODE_OAUTH_TOKEN=')
      expect(cmd).not.toContain('unset CLAUDE_CODE_OAUTH_TOKEN')
    })

    it('the shared-root default (no dir) is unchanged: nothing is unset, an inherited token stays', () => {
      const cmd = buildMainSessionRespawnCmd({ ...base, claudePath: probe, config: mainConfigDecisionForTest() })
      expect(cmd).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
      expect(runWithInheritedToken(cmd)).toBe(`token=${INHERITED} dir=UNSET`)
    })
  })
})
