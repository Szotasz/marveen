import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertCodexSeatConfigCompatible,
  omitDefaultCodexIdentity,
  relayShimPath,
  relayDroppedMcpServers,
  renderCodexConfig,
  renderCodexOverrides,
  resolveCodexSandbox,
  scaffoldCodexHome,
  validateAgentEngine,
  type CodexIdentity,
} from '../web/agent-engine.js'
import { logger } from '../logger.js'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cxdef-'))
  mkdirSync(join(d, '.git')) // project root here: host /tmp state must not reach the relay project-config check
  dirs.push(d)
  return d
}
afterEach(() => {
  vi.restoreAllMocks()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const WS = '/tmp/cxdef-ws'
const RELAY = { profile: 'relay' as const, agentName: 'a' }
const dash = { command: 'node', env: { X: '${X}' } }
const plain = { command: 'uvx' }

describe('relay default', () => {
  it('resolveCodexSandbox', () => {
    expect(resolveCodexSandbox(undefined, 'codex')).toBe('relay')
    expect(resolveCodexSandbox(null, 'codex')).toBe('relay')
    expect(resolveCodexSandbox(undefined, 'claude')).toBe('full-access')
    expect(resolveCodexSandbox('full-access', 'codex')).toBe('full-access')
    expect(() => resolveCodexSandbox('relay', 'claude')).toThrow("codexSandbox requires engine 'codex'")
  })

  it('validateAgentEngine defaults codex to relay', () => {
    expect(validateAgentEngine({ engine: 'codex', codexConfigDir: tmp() }).codexSandbox).toBe('relay')
  })

  it('persistence', () => {
    expect('codexSandbox' in omitDefaultCodexIdentity({ engine: 'codex', codexSandbox: 'relay' })).toBe(false)
    expect(omitDefaultCodexIdentity({ engine: 'codex', codexSandbox: 'full-access' }).codexSandbox).toBe('full-access')
    expect('codexSandbox' in omitDefaultCodexIdentity({ engine: 'claude', codexSandbox: 'full-access' })).toBe(false)
  })
})

describe('relay drops other servers', () => {
  it('relayDroppedMcpServers', () => {
    const servers = { 'marveen-dashboard': dash, zeta: plain, alpha: plain }
    expect(relayDroppedMcpServers(servers, RELAY)).toEqual(['alpha', 'zeta'])
    expect(relayDroppedMcpServers(servers, { profile: 'full-access' })).toEqual([])
    expect(relayDroppedMcpServers(servers)).toEqual([])
  })

  it('renders nothing without a dashboard entry', () => {
    const out = renderCodexConfig(WS, { fetch: plain }, RELAY)
    expect(out).not.toContain('[mcp_servers."')
    expect(out).not.toContain('uvx')
    expect(renderCodexOverrides(WS, { fetch: plain }, RELAY).some(l => l.startsWith('mcp_servers.'))).toBe(false)
  })
})

describe('config.toml env by reference', () => {
  for (const opts of [undefined, { profile: 'full-access' as const }]) {
    it(`literal refusal (${opts ? 'full-access' : 'no profile'})`, () => {
      expect(() => renderCodexConfig(WS, { s: { command: 'x', env: { PLAIN: 'value' } } }, opts))
        .toThrow(/PLAIN of server s would be written into config\.toml as a literal value/)
      process.env.OTHER_CXDEF = 'sekret-cxdef'
      try {
        let msg = ''
        try { renderCodexConfig(WS, { s: { command: 'x', env: { B: '${OTHER_CXDEF}' } } }, opts) } catch (e) { msg = (e as Error).message }
        expect(msg).toMatch(/B of server s would be written into config\.toml as a literal value/)
        expect(msg).not.toContain('sekret-cxdef')
      } finally {
        delete process.env.OTHER_CXDEF
      }
      const ok = renderCodexConfig(WS, { s: { command: 'x', env: { C: '${C}' } } }, opts)
      expect(ok).toContain('env_vars = ["C"]')
      expect(ok).not.toContain('.env]')
      expect(() => renderCodexConfig(WS, { s: { command: 'x', env: { TELEGRAM_BOT_TOKEN: '${TELEGRAM_BOT_TOKEN}' } } }, opts))
        .toThrow('MCP environment variable TELEGRAM_BOT_TOKEN is withheld from Codex agents')
    })
  }

  it('shim exception is narrow', () => {
    const out = renderCodexConfig(WS, { 'marveen-dashboard': dash }, RELAY)
    expect(out).toContain('"MARVEEN_AGENT_NAME" = "a"')
    expect(out).toContain('"MARVEEN_RELAY_DIR" = ')
    expect(() => renderCodexConfig(WS, { 'marveen-dashboard': { command: 'node', env: { MARVEEN_AGENT_NAME: 'a' } } }, { profile: 'full-access' }))
      .toThrow(/literal value/)
  })
})

describe('existing config.toml under relay', () => {
  for (const identity of ['seat', 'overrides'] as CodexIdentity[]) {
    describe(identity, () => {
      const withDash = renderCodexConfig(WS, { 'marveen-dashboard': dash }, RELAY)
      const without = renderCodexConfig(WS, {}, RELAY)
      const check = (content: string) => {
        const home = tmp()
        writeFileSync(join(home, 'config.toml'), content)
        assertCodexSeatConfigCompatible(home, identity, RELAY)
      }
      const header = without.slice(0, without.indexOf('[mcp_servers]'))

      it('refuses other servers', () => {
        const cases = [
          withDash + '\n[mcp_servers."fetch"]\ncommand = "uvx"\n',
          withDash.replace('[mcp_servers]', 'mcp_servers.fetch.command = "uvx"\n[mcp_servers]'),
          header + '[mcp_servers]\nfetch = { command = "uvx" }\n',
          // A dotted key directly under [mcp_servers] defines the server without an inline table.
          header + '[mcp_servers]\nfetch.command = "uvx"\n',
          header + '[mcp_servers]\n"fetch" . command = "uvx"\n',
          header + '[mcp_servers]\n\n[mcp_servers . marveen-dashboard]\ncommand = "uvx"\n',
          header + '[mcp_servers]\n\n[mcp_servers."marveen- dashboard"]\ncommand = "uvx"\n',
          withDash + '\n[[mcp_servers.fetch]]\n',
          // A quoted or escaped key names the same table; the scan refuses what it cannot normalize.
          withDash + '\n["mcp_servers".fetch]\ncommand = "uvx"\n',
          withDash + "\n['mcp_servers'.\"fetch\"]\ncommand = \"uvx\"\n",
          withDash + '\n["mcp\\u005Fservers".fetch]\ncommand = "uvx"\n',
          withDash.replace('[mcp_servers]', '"mcp\\u005Fservers".fetch.command = "uvx"\n[mcp_servers]'),
        ]
        for (const c of cases) expect(() => check(c)).toThrow(/defines an MCP server other than marveen-dashboard/)
      })

      it('refuses a dashboard entry that is not the exact shim entry', () => {
        const argsLine = 'args = ' + JSON.stringify([relayShimPath()])
        expect(withDash.trimEnd().split('\n').at(-1)).toMatch(/MARVEEN_RELAY_DIR/)
        const cases = [
          withDash.replace(argsLine, 'args = ' + JSON.stringify(['/tmp/x.js', relayShimPath()])),
          withDash.replace('command = "node"', 'command = "sh"'),
          withDash.replace('command = "node"', 'command = "node"\ncwd = "/tmp"'),
          withDash.replace('command = "node"', 'command = "node"\nenv_vars = ["X_TOKEN"]'),
          withDash + '"X_TOKEN" = "x"\n',
          // command removed: the args line still names mcp-shim.mjs, so only the exact-entry rule refuses it.
          withDash.replace('command = "node"\n', ''),
          withDash.replace(argsLine, 'args = ' + JSON.stringify(['/repo/scripts/codex-relay/mcp-shim.mjs'])),
        ]
        for (const c of cases) {
          expect(c).not.toBe(withDash)
          expect(() => check(c)).toThrow(/is not the relay shim entry/)
        }
        // args removed: no line names mcp-shim.mjs any more, so the earlier marker check refuses it first.
        const noArgs = withDash.replace(argsLine + '\n', '')
        expect(noArgs).not.toBe(withDash)
        expect(() => check(noArgs)).toThrow(/codexSandbox=relay refuses/)
      })

      it('refuses an env value that opens a multi-line construct', () => {
        const relayLine = withDash.trimEnd().split('\n').at(-1)!
        expect(relayLine).toMatch(/^"MARVEEN_RELAY_DIR" = "/)
        const cases = [
          withDash.replace(relayLine, '"MARVEEN_RELAY_DIR" = """\n[unrelated]\n"""\n"NODE_OPTIONS" = "--require=/tmp/p.cjs"'),
          withDash.replace(relayLine, "\"MARVEEN_RELAY_DIR\" = '''\n[unrelated]\n'''\n\"NODE_OPTIONS\" = \"x\""),
          withDash.replace(relayLine, '"MARVEEN_RELAY_DIR" = [\n[1],\n]\n"NODE_OPTIONS" = "x"'),
          withDash.replace(relayLine, '"MARVEEN_RELAY_DIR" = "/r\\u0022"'),
        ]
        for (const c of cases) {
          expect(c).not.toBe(withDash)
          expect(() => check(c)).toThrow(/is not the relay shim entry/)
        }
      })

      it('an escaped value in the seat config', () => {
        const escaped = without.replace('sandbox_mode = "workspace-write"', 'sandbox_mode = "danger-\\u0066ull-access"')
        expect(escaped).not.toBe(without)
        if (identity === 'seat') expect(() => check(escaped)).toThrow(/backslash/)
        else expect(() => check(escaped)).not.toThrow()
      })

      it('accepts the exact relay rendering', () => {
        expect(() => check(withDash)).not.toThrow()
        expect(() => check(without)).not.toThrow()
        expect(() => check(withDash + '\n# [mcp_servers."fetch"]\n')).not.toThrow()
        const bare = withDash.replace('[mcp_servers."marveen-dashboard"]', '[mcp_servers.marveen-dashboard]')
        expect(bare).not.toBe(withDash)
        expect(() => check(bare)).not.toThrow()
      })
    })
  }
})

describe('scaffold logging', () => {
  it('warns with names only', () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation((() => {}) as never)
    const home = join(tmp(), 'home')
    const ws = tmp()
    mkdirSync(ws, { recursive: true })
    scaffoldCodexHome(home, ws, {
      'marveen-dashboard': { command: 'node', env: { T: '${T}' } },
      other: { command: 'uvx', env: { K: '${K}' }, args: ['--secret-arg-cxdef'] },
    }, 'seat', RELAY)
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ dropped: ['other'] }), expect.stringContaining('codexSandbox=relay'))
    expect(JSON.stringify(spy.mock.calls)).not.toContain('--secret-arg-cxdef')
  })
})
