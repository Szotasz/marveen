// WORKERMCPSEND1104 part 2: the worker keeps one MCP server, the mail server, and may only READ mail with it. Every
// other tool of that server is denied by name in the worker's own settings (deny binds in bypass mode, and an allow
// cannot carve out of a deny, so a per-tool deny list is the documented form). The completeness test below is the
// fail-closed half Samu asked for (67913): the server's tool names come from a FIXED fixture, every one must classify
// as a known reader or a denied tool, and an unknown name fails the test.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  WORKER_MAIL_DENIED_TOOLS, WORKER_MAIL_READ_TOOLS, WORKER_SETTINGS_STRIPPED_KEYS,
  classifyWorkerMailTool, mcpServerSegment, withWorkerMailDeny, workerMailServerNames, workerMcpServers, workerMcpConfigPath,
} from '../web/agent-worker.js'
import { PROJECT_ROOT } from '../config.js'

const ROOT = join(__dirname, '..', '..')
const SERVER = 'server-gmail-autoauth-mcp'

// The tool names of @gongrzhe/server-gmail-autoauth-mcp, measured 2026-11-04 from this install's live MCP tool list
// (every mcp__server-gmail-autoauth-mcp__* name the session exposed). A server update that adds a tool must land here
// first, and then the classification below decides it.
const MAIL_SERVER_TOOLS = [
  'batch_delete_emails', 'batch_modify_emails', 'create_filter', 'create_filter_from_template', 'create_label',
  'delete_email', 'delete_filter', 'delete_label', 'download_attachment', 'draft_email', 'get_filter',
  'get_or_create_label', 'list_email_labels', 'list_filters', 'modify_email', 'read_email', 'search_emails',
  'send_email', 'update_label',
]

const unclassified = (tools: string[]) => tools.filter((t) => classifyWorkerMailTool(t) === 'unknown')

describe('the mail server tool list is fully classified (fail-closed)', () => {
  it('every measured tool is a known reader or a denied tool', () => {
    expect(unclassified(MAIL_SERVER_TOOLS)).toEqual([])
  })

  it('an unknown tool name is reported, never silently allowed', () => {
    expect(unclassified([...MAIL_SERVER_TOOLS, 'send_reply', 'forward_email'])).toEqual(['send_reply', 'forward_email'])
  })

  it('the readers are exactly the read-only tools, and the two sets do not overlap', () => {
    expect([...WORKER_MAIL_READ_TOOLS].sort()).toEqual(['get_filter', 'list_email_labels', 'list_filters', 'read_email', 'search_emails'])
    expect(WORKER_MAIL_READ_TOOLS.filter((t) => WORKER_MAIL_DENIED_TOOLS.includes(t))).toEqual([])
    expect([...WORKER_MAIL_READ_TOOLS, ...WORKER_MAIL_DENIED_TOOLS].sort()).toEqual([...MAIL_SERVER_TOOLS].sort())
  })

  it('every mail tool a worker prompt names is a reader (the heartbeat searches mail)', () => {
    const hb = readFileSync(join(ROOT, 'src', 'heartbeat.ts'), 'utf-8')
    const named = MAIL_SERVER_TOOLS.filter((t) => new RegExp(`\\b${t}\\b`).test(hb))
    expect(named.length).toBeGreaterThan(0)
    for (const t of named) expect(classifyWorkerMailTool(t), t).toBe('read')
  })
})

describe('withWorkerMailDeny', () => {
  it('denies every non-reading tool of each kept mail server, by full name', () => {
    const s = withWorkerMailDeny({}, [SERVER])
    const deny = (s.permissions as { deny: string[] }).deny
    expect(deny.sort()).toEqual(WORKER_MAIL_DENIED_TOOLS.map((t) => `mcp__${SERVER}__${t}`).sort())
    expect(deny).not.toContain(`mcp__${SERVER}__search_emails`)
  })

  it('drops disableAllHooks and env, keeps every other key and every foreign deny entry', () => {
    const s = withWorkerMailDeny({
      disableAllHooks: true, env: { NODE_OPTIONS: '--require /tmp/x.js' }, hooks: { PreToolUse: [] },
      permissions: { deny: ['Bash(curl *)'], allow: ['Read'] }, enabledPlugins: { 'x@y': false },
    }, [SERVER])
    expect([...WORKER_SETTINGS_STRIPPED_KEYS]).toEqual(['disableAllHooks', 'env'])
    expect('disableAllHooks' in s).toBe(false)
    expect('env' in s).toBe(false)
    expect(s.hooks).toEqual({ PreToolUse: [] })
    expect(s.enabledPlugins).toEqual({ 'x@y': false })
    const perms = s.permissions as { deny: string[]; allow: string[] }
    expect(perms.allow).toEqual(['Read'])
    expect(perms.deny).toContain('Bash(curl *)')
  })

  it('is idempotent, and a server no longer kept loses its entries', () => {
    const once = withWorkerMailDeny({}, [SERVER])
    const twice = withWorkerMailDeny(once, [SERVER])
    expect((twice.permissions as { deny: string[] }).deny).toEqual((once.permissions as { deny: string[] }).deny)
    const dropped = withWorkerMailDeny(once, [])
    expect((dropped.permissions as { deny: string[] }).deny).toEqual([])
  })

  it('the server segment follows Claude Code tool naming', () => {
    expect(mcpServerSegment(SERVER)).toBe(SERVER)
    expect(mcpServerSegment('my.mail server')).toBe('my_mail_server')
    const deny = (withWorkerMailDeny({}, ['my.mail server']).permissions as { deny: string[] }).deny
    expect(deny).toContain('mcp__my_mail_server__send_email')
  })
})

describe('workerMailServerNames', () => {
  it('names the allowlisted mail server of the host project entry, and nothing on a read error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-mail-names-'))
    const host = join(dir, '.claude.json')
    writeFileSync(host, JSON.stringify({ projects: { [PROJECT_ROOT]: { mcpServers: {
      [SERVER]: { type: 'stdio', command: 'npx', args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'], env: {} },
      'server-google-calendar-mcp': { type: 'stdio', command: 'npx', args: ['-y', '@cocal/google-calendar-mcp'] },
    } } } }))
    expect(workerMailServerNames(host, null)).toEqual([SERVER])
    expect(workerMailServerNames(join(dir, 'missing.json'), null)).toEqual([])
    // the strict MCP config's content: the kept server entry, exactly as configured, and nothing else
    expect(Object.keys(workerMcpServers(host, null))).toEqual([SERVER])
    expect(workerMcpServers(join(dir, 'missing.json'), null)).toEqual({})
  })
})

// Measured 2026-11-04 (work/workermcpsend-docs.md): with --strict-mcp-config --mcp-config <file> Claude Code loads ONLY
// the file's servers; without it, user-scope, project and ancestor .mcp.json servers came too.
describe('the worker launches with a strict MCP config of its own', () => {
  it('the config file lives in the worker config dir', () => {
    expect(workerMcpConfigPath({ configDir: '/w/.claude-config' })).toBe('/w/.claude-config/worker-mcp.json')
  })

  it('ensureWorkerCwd writes the kept servers into it, and the launch line passes both flags', () => {
    const src = readFileSync(join(ROOT, 'src', 'web', 'agent-worker.ts'), 'utf-8')
    const ensure = src.slice(src.indexOf('export function ensureWorkerCwd'))
    expect(ensure).toContain('const keptMcp = existsSync(join(homedir(), \'.claude.json\')) ? workerMcpServers() : {}')
    expect(ensure).toContain('writeFileSync(workerMcpConfigPath(ctx), JSON.stringify({ mcpServers: keptMcp }')
    expect(src).toMatch(/--dangerously-skip-permissions --model \$\{shArg\(workerModel\)\} ` \+\s*\n\s*\/\/[^\n]*\n\s*`--strict-mcp-config --mcp-config \$\{shArg\(workerMcpConfigPath\(ctx\)\)\}`/)
  })
})

describe('wiring (static)', () => {
  it('ensureWorkerCwd writes the worker settings through withWorkerMailDeny', () => {
    const src = readFileSync(join(ROOT, 'src', 'web', 'agent-worker.ts'), 'utf-8')
    const body = src.slice(src.indexOf('export function ensureWorkerCwd'))
    expect(body).toContain('withWorkerMailDeny({ ...current, enabledPlugins, skipDangerousModePermissionPrompt: true }, mailServers)')
    expect(body).toContain('const mailServers = Object.keys(keptMcp)')
  })
})
