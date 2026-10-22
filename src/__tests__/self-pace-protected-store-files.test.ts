// Kanban c556a35a: four more store files are gates on the sub-agent itself, so a sub-agent may
// not write them, exactly like the egress allowlist (EGRESSSELFEDIT824):
//   egress-vendor-hosts.json      -- the hosts bash-egress-parser lets curl/wget reach
//   config-overrides.json         -- dashboard settings, BASH_SANDBOX_AGENTS among them
//   bash-sandbox-write-paths.json -- where a sandboxed agent may write (#2149)
//   email-standing-recipients.json -- addresses a letter may go to without an approval
//   .approval-bot-token, .approval-bot-key -- the owner's approval bot and its signing key (#2160)
// Their legitimate writers are the owner and the main agent (and the dashboard process for
// config-overrides.json); none of them runs this gate.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, protectedStoreBashSegmentAllowed, PROTECTED_STORE_FILES } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const SETTINGS_FILES = ['egress-vendor-hosts.json', 'config-overrides.json', 'bash-sandbox-write-paths.json', 'email-standing-recipients.json']
// secrets: not even a read (review on #2153, for #2160)
const SECRET_FILES = ['.approval-bot-token', '.approval-bot-key']
const FILES = [...SETTINGS_FILES, ...SECRET_FILES]

let root: string
let store: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'protected-store-'))
  store = join(root, 'store')
  mkdirSync(store)
  for (const f of FILES) writeFileSync(join(store, f), '{}')
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const decide = (tool: string, input: Record<string, unknown>) =>
  gateDecision(tool, input, { storeDir: store, allowlistPath: join(store, 'egress-allowlist.json'), cwd: root })
const DENY = { deny: true, reason: 'protected-store-file' }
const SECRET_DENY = { deny: true, reason: 'secret-store-file' }

it('the protected list is exactly the files of the card (four, and the approval bot\'s two)', () => {
  expect([...PROTECTED_STORE_FILES].sort()).toEqual([...FILES].sort())
})

describe('native file tools', () => {
  for (const f of FILES) {
    it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])(`%s on ${f} is denied`, (tool) => {
      expect(decide(tool, { file_path: join(store, f), content: '{}' })).toEqual(DENY)
    })
    it(`a relative path to ${f} is denied`, () => {
      expect(decide('Edit', { file_path: `store/${f}` })).toEqual(DENY)
    })
    it(`a symlink under another name that resolves to ${f} is denied (real-path check)`, () => {
      const link = join(root, `innocent-${f}`)
      symlinkSync(join(store, f), link)
      expect(decide('Write', { file_path: link, content: '{}' })).toEqual(DENY)
    })
  }
  it('another file in store/ is not affected', () => {
    expect(decide('Write', { file_path: join(store, 'other.json'), content: '{}' }).deny).toBe(false)
  })
  it('a similar name is not the file', () => {
    expect(decide('Write', { file_path: join(root, 'config-overrides.example.json'), content: '{}' }).deny).toBe(false)
    expect(decide('Write', { file_path: join(root, 'src', 'config-overrides.ts'), content: '' }).deny).toBe(false)
  })
  it('the egress allowlist keeps its own reason', () => {
    expect(decide('Write', { file_path: join(store, 'egress-allowlist.json'), content: '{}' })).toEqual({ deny: true, reason: 'egress-allowlist' })
  })
})

describe('Bash is fail-closed on the protected files', () => {
  const writes = (f: string) => [
    `echo '{}' > store/${f}`,
    `echo x >> store/${f}`,
    `cat new.json | tee store/${f}`,
    `cp /tmp/x.json store/${f}`,
    `mv /tmp/x.json store/${f}`,
    `sed -i '' 's/a/b/' store/${f}`,
    `ln -sf /tmp/x store/${f}`,
    `python3 -c "import json;json.dump({},open('store/${f}','w'))"`,
    `node -e "require('fs').writeFileSync('store/${f}','{}')"`,
    `cd store && cp /tmp/x.json ${f}`,
    `python3 - <<PY\nopen("store/${f}","w").write("{}")\nPY`,
    `jq '.x = 1' store/${f} > $TARGET`,
    `rm store/${f}`,
  ]
  for (const f of SETTINGS_FILES) {
    it.each(writes(f))('denies: %s', (command) => {
      expect(decide('Bash', { command })).toEqual(DENY)
    })
  }
  for (const f of SECRET_FILES) {
    it.each(writes(f))('denies (a secret): %s', (command) => {
      expect(decide('Bash', { command })).toEqual(SECRET_DENY)
    })
  }
  it.each([
    'cp /tmp/x store/egress-vendor*',
    'cp /tmp/x store/config-overrides.*',
    'cp /tmp/x store/bash-sandbox-write*',
    'cp /tmp/x store/email-standing*',
  ])('a glob that starts on the name is denied: %s', (command) => {
    expect(decide('Bash', { command })).toEqual(DENY)
  })
  it.each(['cp /tmp/x store/.approval-bot*', 'cat store/.approval-bot*', 'ls store/.approval-bot*'])('a glob on a secret is denied, even to a reader: %s', (command) => {
    expect(decide('Bash', { command })).toEqual(SECRET_DENY)
  })

  const reads = (f: string) => [
    `cat store/${f}`,
    `jq . store/${f}`,
    `grep -c x store/${f}`,
    `shasum -a 256 store/${f}`,
    `ls -la store/${f}`,
    `cat store/${f} > /tmp/copy.json`,
    `diff store/${f} /tmp/copy.json`,
  ]
  for (const f of SETTINGS_FILES) {
    it.each(reads(f))('allows: %s', (command) => {
      expect(decide('Bash', { command }).deny).toBe(false)
    })
  }
  for (const f of SECRET_FILES) {
    it.each(reads(f))('a READ of a secret is denied too: %s', (command) => {
      expect(decide('Bash', { command })).toEqual(SECRET_DENY)
    })
  }
  it.each([
    // talking about a file is not writing it
    `curl -X POST http://localhost:3420/api/messages -d '{"to":"marveen","content":"add x to store/egress-vendor-hosts.json"}'`,
    'git commit -m "docs: store/config-overrides.json is owner-managed"',
    "cat > /tmp/note.md <<'EOF'\nsub-agents may not edit store/email-standing-recipients.json\nEOF",
    // source and test files with the same stem are not the store object
    'npx vitest run src/__tests__/self-pace-protected-store-files.test.ts',
    'git diff develop -- src/web/bash-sandbox.ts src/config-registry.ts',
    'python3 scripts/__tests__/email-approval-gate.test.py',
    'bash scripts/__tests__/install-tz.test.sh',
    'ls src/web/bash-sandbox*',
    // the approval bot's own source and test are not its token
    'git commit -m "docs: store/.approval-bot-token is the owner\'s, the server reads it"',
    `curl -X POST http://localhost:3420/api/messages -d '{"to":"marveen","content":"the approval bot does not answer, is store/.approval-bot-token set?"}'`,
    'git add src/approval-bot.ts src/__tests__/approval-bot.test.ts',
    // without the leading dot these would read as the token/key file (a doc name, a glob on the sources)
    'git add docs/approval-bot-key-rotation.md',
    'git add src/approval-bot* src/__tests__/approval-bot*',
    'npx vitest run src/__tests__/approval-bot.test.ts',
    // a glob on the feature's sources is not a glob on the store file (a writer, so it would be denied)
    'git add src/web/bash-sandbox* src/__tests__/bash-sandbox*',
    'cp a.json b.json',
  ])('allows: %s', (command) => {
    expect(decide('Bash', { command }).deny).toBe(false)
  })

  it('the segment check alone: a reader passes, a writer does not', () => {
    expect(protectedStoreBashSegmentAllowed('head -5 store/config-overrides.json')).toBe(true)
    expect(protectedStoreBashSegmentAllowed('truncate -s 0 store/config-overrides.json')).toBe(false)
  })
})

describe('the hook end to end', () => {
  const hook = join(__dirname, '..', '..', 'scripts', 'self-pace-gate.mjs')
  const run = (payload: unknown) =>
    spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: 'utf-8' })

  it.each(FILES)('a Write to %s is denied with the protected-file message, which names the file', (f) => {
    const r = run({ tool_name: 'Write', tool_input: { file_path: `/x/store/${f}`, content: '{}' }, cwd: root })
    const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason
    expect(reason).toContain(f)
    expect(reason).toContain('fo agenst')
    expect(reason).not.toContain('Self-pace TILTOTT')
  })
  it('a Bash write gets the same message', () => {
    const r = run({ tool_name: 'Bash', tool_input: { command: 'echo x > store/email-standing-recipients.json' }, cwd: root })
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toContain('email-standing-recipients.json')
  })
  it('a Bash READ of a secret is denied with the secret message, which offers no read', () => {
    const r = run({ tool_name: 'Bash', tool_input: { command: 'cat store/.approval-bot-token' }, cwd: root })
    const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason
    expect(reason).toContain('Titok TILTOTT')
    expect(reason).toContain('.approval-bot-token')
    expect(reason).not.toMatch(/Olvasni szabad/)
  })
  it('the protected-file message no longer offers a read of the two secrets', () => {
    const r = run({ tool_name: 'Write', tool_input: { file_path: '/x/store/config-overrides.json', content: '{}' }, cwd: root })
    const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason
    expect(reason).toMatch(/Olvasni szabad[^.]*KIVEVE a \.approval-bot-token es \.approval-bot-key/)
  })
  it('POSITIVE CONTROL: a read passes through the hook', () => {
    const r = run({ tool_name: 'Bash', tool_input: { command: 'cat store/egress-vendor-hosts.json' }, cwd: root })
    expect(r.stdout).toBe('')
    expect(r.status).toBe(0)
  })
  it('POSITIVE CONTROL: the allowlist message is unchanged', () => {
    const r = run({ tool_name: 'Write', tool_input: { file_path: '/x/store/egress-allowlist.json', content: '{}' }, cwd: root })
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toContain('Egress-engedelylista TILTOTT')
  })
})
