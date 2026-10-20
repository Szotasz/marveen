import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { curlCommands, fillPlaceholders, runCommand, shapeViolations, startStub, type SeenRequest } from './helpers/curl-commands.js'

// The curl commands the generators hand to agents must WORK, not
// just look right. Everything here is rendered by the real generator, cut into commands, shape-checked,
// and then RUN against a local stub server, from an install whose path contains a space and a single quote.
// An unquoted $(cat <path>) splits at the space, curl sends an empty Bearer and the stub sees the wrong
// header: exactly the failure the source-text regexes could not see.

const TOKEN = 'tok-0123456789abcdef0123456789abcdef'

// vi.mock factories run when the module is first imported, which is after beforeAll below has
// started the stub; the shared state travels in a hoisted object.
const st = vi.hoisted(() => ({ port: 0, root: '', proj: '', plain: '' }))

vi.mock('../config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config.js')>()
  return {
    ...original,
    STORE_DIR: `${st.proj}/store`,
    PROJECT_ROOT: st.proj,
    WEB_HOST: '127.0.0.1',
    WEB_PORT: st.port,
    DASHBOARD_PUBLIC_URL: '',
    AGENT_API_ORIGIN: '',
  }
})
vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(st.root, 'agents', name),
  agentConfigRoot: () => join(st.root, 'agents'),
  listAgentNames: () => ['agent-a', 'agent-b'],
  readAgentCapabilities: () => [],
}))
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const REPO = join(__dirname, '..', '..')
let stub: Awaited<ReturnType<typeof startStub>>
const corpus: Record<string, { text: string; cwd?: string; prelude?: string; needs?: string }> = {}
let jqAvailable = false

beforeAll(async () => {
  stub = await startStub()
  st.port = stub.port
  st.root = mkdtempSync(join(tmpdir(), 'marveen-curl-rendered-'))
  // A space AND a single quote: the two characters that break an unquoted or naively quoted path.
  st.proj = join(st.root, "pro ject's root")
  // The JSON template wraps the path in single quotes, so its own case uses a space only.
  st.plain = join(st.root, 'pro ject root')
  for (const dir of [st.proj, st.plain]) {
    mkdirSync(join(dir, 'store'), { recursive: true })
    writeFileSync(join(dir, 'store', '.dashboard-token'), TOKEN + '\n')
  }
  mkdirSync(join(st.root, 'agents', 'agent-a'), { recursive: true })
  writeFileSync(join(st.root, 'agents', 'agent-a', 'CLAUDE.md'), '# agent-a\n')
  jqAvailable = spawnSync('jq', ['--version']).status === 0

  const kanban = await import('../web/routes/kanban.js')
  const voice = await import('../web/voice-directive.js')
  const scaffold = await import('../web/agent-scaffold.js')
  const onboarding = await import('../web/federation/onboarding.js')
  const rotation = await import('../web/claude-rotation-heartbeat.js')
  const heartbeat = await import('../web/heartbeat-agent-scaffold.js')

  corpus['kanban dispatch'] = { text: kanban.kanbanMoveInstructions('abc123', 'cody') }
  corpus['voice directive'] = { text: voice.buildTtsDirective({ chatId: '1', stateDir: join(st.proj, 'state'), voiceModel: 'v' }) ?? '', needs: 'jq' }
  corpus['message-close body'] = { text: scaffold.buildMessageCloseBody() }
  corpus['system-directive auth body'] = { text: scaffold.buildSystemDirectiveAuthBody('agent-a') }
  corpus['agent-id header body'] = { text: scaffold.buildAgentIdHeaderBody('agent-a') }
  corpus['memory-search label body'] = { text: scaffold.buildMemorySearchLabelBody('agent-a') }
  scaffold.ensureAutonomySection('agent-a')
  corpus['autonomy section'] = { text: readFileSync(join(st.root, 'agents', 'agent-a', 'CLAUDE.md'), 'utf-8') }

  const cfg = {
    enabled: true,
    systemId: 'arthur',
    peers: [{ id: 'teodor', baseUrl: 'https://teodor.example', outboundToken: 'x'.repeat(64), inboundToken: 'y'.repeat(64), trust: 'untrusted' as const }],
  }
  for (const lang of ['hu', 'en'] as const) {
    const id = { botName: 'Arthur', mainAgentId: 'arthur', webPort: stub.port, lang }
    corpus[`federation block ${lang}`] = { text: onboarding.renderFederationBlock(cfg, id), cwd: st.proj }
    corpus[`federation sub-agent block ${lang}`] = { text: onboarding.renderSubAgentFederationBlock(id), cwd: st.proj }
  }
  corpus['rotation heartbeat prompt'] = { text: rotation.buildRotationHeartbeatPrompt({ projectRoot: st.proj, webPort: stub.port, chatId: '1' }) }

  const hbText = heartbeat.renderHeartbeatClaudeMd({
    ...heartbeat.currentHeartbeatIdentity(),
    storeDir: join(st.proj, 'store'),
    dashboardOrigin: `http://127.0.0.1:${stub.port}`,
  })
  // The scaffold reads the token into a variable on its own line and uses it in the next command.
  corpus['heartbeat scaffold'] = { text: hbText, prelude: hbText.split('\n').find((l) => /^\s*TOKEN=\$\(cat /.test(l))?.trim() }

  const claudeMd = readFileSync(join(REPO, 'templates', 'CLAUDE.md.template'), 'utf-8')
    .replace(/\{\{WEB_PORT\}\}/g, String(stub.port))
    .replace(/\{\{[A-Z_]+\}\}/g, 'x')
  corpus['CLAUDE.md.template'] = { text: claudeMd, cwd: st.proj }

  // settings.json.template: the PreCompact agent-hook prompt is one JSON string holding curl commands.
  const settings = JSON.parse(readFileSync(join(REPO, 'templates', 'settings.json.template'), 'utf-8'))
  const prompts: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') { if (v.includes('curl ')) prompts.push(v) }
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(settings)
  corpus['settings.json.template prompt'] = {
    text: prompts.join('\n').replace(/\{\{PROJECT_ROOT\}\}/g, st.plain).replace(/\{\{WEB_PORT\}\}/g, String(stub.port)).replace(/\{\{[A-Z_]+\}\}/g, 'x'),
    cwd: st.plain,
  }

  const py = (script: string, ...args: string[]) => {
    const r = spawnSync('python3', ['-c', script, ...args], { encoding: 'utf-8', timeout: 20_000 })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout
  }
  const loader = 'import importlib.util,sys;s=importlib.util.spec_from_file_location("hook",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);'
  corpus['memory-lookup-nudge.py'] = {
    text: py(loader + 'print(m.nudge("samu",int(sys.argv[2]),sys.argv[3]))', join(REPO, 'scripts/hooks/memory-lookup-nudge.py'), String(stub.port), join(st.proj, 'store', '.dashboard-token')),
  }
  const tokenFile = join(st.proj, 'store', '.dashboard-token')
  corpus['provenance-gate.py self-task (untraced)'] = {
    text: py(loader + 'print(m.self_task_trace_text(["a"],"neo","merlin",int(sys.argv[2]),sys.argv[3],logged=False))', join(REPO, 'scripts/hooks/provenance-gate.py'), String(stub.port), tokenFile),
  }
})

afterAll(() => {
  stub?.server.close()
  if (st.root) rmSync(st.root, { recursive: true, force: true })
})

const SOURCES = [
  'kanban dispatch', 'voice directive', 'message-close body', 'system-directive auth body',
  'agent-id header body', 'memory-search label body', 'autonomy section',
  'federation block hu', 'federation block en', 'federation sub-agent block hu', 'federation sub-agent block en',
  'rotation heartbeat prompt', 'heartbeat scaffold', 'CLAUDE.md.template', 'settings.json.template prompt',
  'memory-lookup-nudge.py', 'provenance-gate.py self-task (untraced)',
]

describe('rendered generator output: every curl command is well-formed AND works', () => {
  for (const name of SOURCES) {
    it(`${name}: shape rules hold and each command reaches the server with the right token`, async () => {
      const src = corpus[name]
      expect(src.text.length, `${name} rendered nothing`).toBeGreaterThan(0)
      const commands = curlCommands(src.text)
      // Not vacuous: the source really carries a curl (the memory-search label body etc. do).
      const carriers = commands.length
      expect(carriers, `${name}: no curl command found in the rendered text`).toBeGreaterThan(0)

      for (const raw of commands) {
        expect(shapeViolations(raw), `${name}: ${raw.split('\n')[0].slice(0, 160)}`).toEqual([])
        // The token VALUE must never be in the command text (it would be on argv).
        expect(raw).not.toContain(TOKEN)

        if (src.needs === 'jq' && !jqAvailable) continue
        const before: SeenRequest[] = stub.seen.slice()
        const cmd = (src.prelude ? src.prelude + '\n' : '') + fillPlaceholders(raw)
        const r = await runCommand(cmd, src.cwd ?? st.proj, st.root)
        expect(r.code, `${name}: ${raw.split('\n')[0].slice(0, 160)}\n${r.out.slice(0, 400)}`).toBe(0)
        const fresh = stub.seen.slice(before.length)
        expect(fresh.length, `${name}: the command sent no request: ${raw.slice(0, 300)}\n${r.out.slice(0, 300)}`).toBeGreaterThan(0)
        for (const req of fresh) {
          expect(req.authorization, `${name}: ${req.method} ${req.url}`).toBe(`Bearer ${TOKEN}`)
        }
      }
    })
  }

  it('control: an UNQUOTED token path in the same install really does fail (the test can see the bug)', async () => {
    const unquoted = `printf 'header = "Authorization: Bearer %s"\\n' "$(cat ${join(st.plain, 'store', '.dashboard-token')})" | curl -s -K - http://127.0.0.1:${stub.port}/api/x`
    const before = stub.seen.length
    await runCommand(unquoted, st.root, st.root)
    const fresh = stub.seen.slice(before)
    expect(fresh.length).toBe(1)
    expect(fresh[0].authorization).not.toBe(`Bearer ${TOKEN}`)
  })
})
