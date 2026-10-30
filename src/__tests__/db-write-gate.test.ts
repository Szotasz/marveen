// APPROVALDBGATE1030 -- scripts/hooks/db-write-gate.mjs, for every agent including the
// main one (Samu 56076, option B):
//   1. no SQL write on the dashboard's security tables, by any program;
//   2. no file-level write of the dashboard database;
//   3. no write of THIS INSTALL's gate wiring and autonomy levels (Dani 56081 point 5,
//      Samu 56090: the install, not a worktree copy; Dani 56096: after realpath, "..",
//      symlink and case folding, in Bash as in the file tools).
// Message text that quotes such a command passes, but only its data argument is dropped
// (Dani 56100). The gate is a text-based brake, not an OS boundary (stated in both messages).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, DB_GATE_MSG, GIT_GATE_MSG, INSTALL_FILE_GATE_MSG, PROTECTED_INSTALL_PATHS } from '../../scripts/hooks/db-write-gate.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import { SECURITY_TABLES, gateDecision as selfPaceDecision } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { injectDbWriteGate, DB_WRITE_GATE_MATCHER } from '../web/agent-scaffold.js'
import { KNOWN_HOOK_SCRIPTS } from '../web/hook-registration-guard.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOOK = join(REPO, 'scripts', 'hooks', 'db-write-gate.mjs')
// Spelled in two pieces so this file's own text is not a database reference.
const DB = 'store/claude' + 'claw.db'

let base: string
let root: string // the "install"
let wt: string // a worktree of it
function scaffold(dir: string): void {
  mkdirSync(join(dir, '.claude'), { recursive: true })
  mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true })
  mkdirSync(join(dir, 'store'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.json'), '{}')
  writeFileSync(join(dir, '.claude', 'settings.local.json'), '{}')
  writeFileSync(join(dir, 'scripts', 'hooks', 'gate.py'), '')
  writeFileSync(join(dir, 'scripts', 'self-pace-gate.mjs'), '')
  writeFileSync(join(dir, 'store', 'extra-hooks.json'), '{}')
  writeFileSync(join(dir, 'store', 'autonomy-config.json'), '{}')
}
// The install is a main checkout (a .git directory), the worktree has a .git file, as git makes them.
function gitScaffold(): void {
  mkdirSync(join(root, '.git', 'refs', 'remotes', 'origin'), { recursive: true })
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
  writeFileSync(join(root, '.git', 'config'), '')
  writeFileSync(join(root, '.git', 'packed-refs'), '')
  writeFileSync(join(root, '.git', 'refs', 'remotes', 'origin', 'develop'), '')
  writeFileSync(join(wt, '.git'), `gitdir: ${root}/.git/worktrees/wt\n`)
}
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'db-write-gate-')))
  root = join(base, 'Install')
  wt = join(base, 'install-wt')
  scaffold(root)
  scaffold(wt)
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

// @ROOT@ / @WT@: it.each tables are built before beforeEach runs, so the paths are filled in here
const bash = (command: string, cwd = root) =>
  gateDecision('Bash', { command: command.replaceAll('@ROOT@', root).replaceAll('@WT@', wt) }, { cwd, root })
const file = (tool: string, file_path: string, cwd = root) => gateDecision(tool, { file_path, content: '{}' }, { cwd, root })
const DENY_DB = { deny: true, reason: 'db' }
const DENY_FILE = { deny: true, reason: 'install-file' }
const ALLOW = { deny: false }

describe('1. SQL writes on the security tables', () => {
  it('the table list is the decided six', () => {
    expect(SECURITY_TABLES).toEqual(['approvals', 'approval_events', 'auth_sessions', 'dashboard_users', 'device_keys', 'vault_ssh_keys'])
  })
  for (const t of ['approvals', 'approval_events', 'auth_sessions', 'dashboard_users', 'device_keys', 'vault_ssh_keys']) {
    it.each([
      `UPDATE ${t} SET x=1`,
      `INSERT INTO ${t} VALUES (1)`,
      `DELETE FROM ${t}`,
      `REPLACE INTO ${t} VALUES (1)`,
      `DROP TABLE ${t}`,
      `ALTER TABLE ${t} ADD COLUMN y`,
    ])(`sqlite3 "%s" is denied`, (sql) => {
      expect(bash(`sqlite3 ${DB} "${sql}"`)).toEqual(DENY_DB)
    })
  }
  // Dani 56081 point 6: the table name anywhere the statement writes it
  it.each([
    ['a CTE', `WITH a AS (SELECT 1) UPDATE approvals SET status='approved'`],
    ['INSERT OR REPLACE', 'INSERT OR REPLACE INTO approvals VALUES (1)'],
    ['an UPSERT', 'INSERT INTO approvals (id) VALUES (1) ON CONFLICT(id) DO UPDATE SET status=1'],
    ['UPDATE OR REPLACE', 'UPDATE OR REPLACE approvals SET status=1'],
    ['a trigger on another table that writes it', 'CREATE TRIGGER t AFTER INSERT ON daily_logs BEGIN UPDATE approvals SET status=1; END'],
    ['a trigger on it', 'CREATE TRIGGER t BEFORE UPDATE ON approvals BEGIN SELECT RAISE(IGNORE); END'],
    ['an index on it', 'CREATE UNIQUE INDEX i ON approvals(status)'],
    ['a double-quoted, schema-prefixed name', 'UPDATE "main"."approvals" SET status=1'],
    ['a bracketed name', 'UPDATE [approvals] SET status=1'],
    ['a backticked name', 'UPDATE `approvals` SET status=1'],
    ['upper case', 'UPDATE APPROVALS SET STATUS=1'],
    ['mixed case', 'Update Approvals Set status=1'],
    ['an ATTACHed schema', `ATTACH '/tmp/x.db' AS m; UPDATE m.approvals SET status=1`],
    ['a comment between the words', 'UPDATE/**/approvals SET status=1'],
    ['a line comment between the words', 'DELETE --x\nFROM approval_events'],
    // Dani 56276 1: the schema route, which never spells the table's name
    ['PRAGMA writable_schema', 'PRAGMA writable_schema=1'],
    ['PRAGMA writable_schema with a schema and ON', 'PRAGMA main.writable_schema = ON'],
    ['PRAGMA writable_schema quoted', 'PRAGMA "writable_schema"=1'],
    ['a rename through sqlite_master by char()', "UPDATE sqlite_master SET name='zz', tbl_name='zz' WHERE name=char(97,112,112,114,111,118,97,108,115)"],
    ['a write on sqlite_schema', "UPDATE sqlite_schema SET sql='x' WHERE type='table'"],
    ['a write on sqlite_temp_master', 'DELETE FROM sqlite_temp_master'],
    ['a write on an ATTACHed schema table', "UPDATE m.sqlite_master SET name='zz'"],
  ])('%s is denied', (_, sql) => {
    expect(bash(`sqlite3 ${DB} '${sql}'`)).toEqual(DENY_DB)
  })
  it.each([
    ['python -c', `python3 -c "import sqlite3; sqlite3.connect('${DB}').execute('UPDATE approvals SET status=1')"`],
    ['node -e', `node -e "new (require('better-sqlite3'))('${DB}').exec('DELETE FROM auth_sessions')"`],
    ['a heredoc on sqlite3 stdin (Dani 56100 #3)', `sqlite3 ${DB} <<EOF\nUPDATE approvals SET status='approved';\nEOF`],
    ['a quoted heredoc on python stdin', `python3 - <<'PY'\nimport sqlite3\nsqlite3.connect('${DB}').execute("UPDATE approvals SET status=1")\nPY`],
    ['echo into sqlite3', `echo "UPDATE approvals SET status=1" | sqlite3 ${DB}`],
    ['a statement file written in the same command', `printf 'UPDATE approvals SET status=1' > /tmp/s.sql; sqlite3 ${DB} < /tmp/s.sql`],
    ['a statement file written by grep', `grep -h "UPDATE approvals" notes.txt > /tmp/s.sql`],
    ['bash -c', `bash -c "sqlite3 ${DB} 'UPDATE approvals SET status=1'"`],
    ['python -c whose code also has a "content" key (Dani 56100 #2)',
      `python3 -c "import sqlite3; d={'content':'x'}; sqlite3.connect('${DB}').execute('UPDATE approvals SET status=1')"`],
  ])('%s is denied', (_, cmd) => {
    expect(bash(cmd)).toEqual(DENY_DB)
  })
  // Dani 56100 #1: a message command in front does not carry the write through
  const MSG = `curl -s -X POST http://localhost:3420/api/messages -d '{"content":"x"}'`
  const WRITE = `sqlite3 ${DB} 'UPDATE approvals SET status=1'`
  it.each([
    ['after ;', `${MSG} ; ${WRITE}`],
    ['after &&', `${MSG} && ${WRITE}`],
    ['after |', `${MSG} | ${WRITE}`],
    ['after a newline', `${MSG}\n${WRITE}`],
    ['inside $( )', `${MSG} -H "X: $(${WRITE})"`],
    ['inside backticks', `${MSG} -H "X: \`${WRITE}\`"`],
  ])('a write %s a message command is denied', (_, cmd) => {
    expect(bash(cmd)).toEqual(DENY_DB)
  })

  it.each([
    ['a SELECT', `sqlite3 ${DB} "SELECT * FROM approvals WHERE status='pending'"`],
    ['a read-only open', `sqlite3 -readonly ${DB} "SELECT count(*) FROM auth_sessions"`],
    ['UPDATE agent_messages (the global skills)', `sqlite3 ${DB} "UPDATE agent_messages SET status='done' WHERE id=5"`],
    ['the daily_logs date fix (CLAUDE.md)', `sqlite3 ${DB} "UPDATE daily_logs SET date='2026-10-29' WHERE id=12; SELECT changes();"`],
    ['a longer table name', `sqlite3 ${DB} "UPDATE approvals_archive SET x=1"`],
    ['grep for the statement', `grep -rn "UPDATE approvals" src/`],
    ['a copy through VACUUM INTO', `sqlite3 -readonly ${DB} "VACUUM INTO '/tmp/x.db'"`],
    ['a schema read', `sqlite3 -readonly ${DB} "SELECT sql FROM sqlite_master WHERE name='approvals'"`],
    ['another pragma', `sqlite3 -readonly ${DB} "PRAGMA table_info(approvals)"`],
  ])('%s passes', (_, cmd) => {
    expect(bash(cmd)).toEqual(ALLOW)
  })
  // Dani 56100: the legit side -- a message, a kanban comment, a commit that QUOTE it
  it.each([
    ['an inter-agent message (curl -d)', `curl -s -X POST http://localhost:3420/api/messages -H "Content-Type: application/json" -H "Authorization: Bearer $(cat @ROOT@/store/.dashboard-token)" -d '{"from":"bence","to":"dani","content":"the gate denies: sqlite3 ${DB} UPDATE approvals SET status=1"}'`],
    ['an inter-agent message (quoted heredoc on stdin)', `curl -s -X POST http://localhost:3420/api/messages --data-binary @- <<'JSON'\n{"content":"denied: UPDATE approvals SET status=1, and \`.claude/settings.json\`"}\nJSON`],
    ['a message whose reply goes to a file', `curl -s -X POST http://localhost:3420/api/messages -d '{"content":"UPDATE approvals is gated"}' > /tmp/reply.json`],
    ['a kanban comment through the API', `curl -s -X POST http://localhost:3420/api/kanban/X/comments -d '{"content":"INSERT INTO approvals is now gated"}'`],
    ['the kanban tool with a title', `python3 @ROOT@/scripts/kartya-es-ertesites.py --id X --title "Update approvals flow" --comment-file /tmp/c.txt --author Marveen`],
    ['a commit message', `git commit -m "fix: deny UPDATE approvals in every spelling"`],
    ['a commit message from stdin', `git commit -F - <<'EOF'\nfix: deny DELETE FROM auth_sessions\nEOF`],
    ['a PR body', `gh pr create --title "db gate" --body "blocks UPDATE approvals SET status"`],
  ])('%s passes', (_, cmd) => {
    expect(bash(cmd)).toEqual(ALLOW)
  })
  it('the kanban tool carries only its title: a write elsewhere in the command is still denied', () => {
    expect(bash(`python3 @ROOT@/scripts/kartya-es-ertesites.py --id X --title "x" ; ${WRITE}`)).toEqual(DENY_DB)
    expect(bash(`python3 -c "x" @ROOT@/scripts/kartya-es-ertesites.py --title "UPDATE approvals SET y=1"`)).toEqual(DENY_DB)
    expect(bash(`python3 @ROOT@/scripts/kartya-es-ertesites.py --title "x" --id "UPDATE approvals SET y=1"`)).toEqual(DENY_DB)
  })
  it('a quoted message written to a FILE by a heredoc is not data (a script the next step can run)', () => {
    expect(bash(`cat > /tmp/m.txt <<'EOF'\nUPDATE approvals SET status=1\nEOF`)).toEqual(DENY_DB)
  })
})

describe('2. file-level writes of the database', () => {
  it.each([
    ['cp onto it', `cp /tmp/x.db ${DB}`],
    ['a redirect onto the WAL', `echo x > ${DB}-wal`],
    ['rm of the SHM', `rm ${DB}-shm`],
    ['tee onto the journal', `echo x | tee ${DB}-journal`],
    ['a sqlite3 .restore', `sqlite3 ${DB} ".restore /tmp/x.db"`],
    ['a sqlite3 .read', `sqlite3 ${DB} ".read /tmp/x.sql"`],
    ['a glob spelling', `cp /tmp/x.db store/claude*.db`],
  ])('%s is denied', (_, cmd) => {
    expect(bash(cmd)).toEqual(DENY_DB)
  })
  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('%s on the database is denied', (tool) => {
    expect(file(tool, join(root, DB))).toEqual(DENY_DB)
    expect(file(tool, join(wt, `${DB}-wal`))).toEqual(DENY_DB)
  })
})

describe('3. this install\'s gate wiring and autonomy levels', () => {
  const REL = ['.claude/settings.json', '.claude/settings.local.json', 'scripts/hooks/gate.py', 'scripts/hooks/new.py',
    'scripts/self-pace-gate.mjs', 'store/extra-hooks.json', 'store/autonomy-config.json']
  it('the protected list is the decided one', () => {
    expect(PROTECTED_INSTALL_PATHS.map((t: { rel?: string, home?: string }) => t.rel ?? `~/${t.home}`)).toEqual(['.claude/settings.json',
      '.claude/settings.local.json', 'scripts/hooks', 'scripts/self-pace-gate.mjs', 'store/extra-hooks.json', 'store/autonomy-config.json',
      '.git/config', '.git/packed-refs', '.git/refs/remotes', '.git/hooks', '~/.gitconfig', '~/git/config'])
  })
  for (const rel of REL) {
    it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])(`%s on the install's ${rel} is denied`, (tool) => {
      expect(file(tool, join(root, rel))).toEqual(DENY_FILE)
    })
    // Samu 56090 / Dani 56096 (1): the same Edit on the worktree's own file passes
    it(`the same Edit on the worktree's ${rel} passes`, () => {
      expect(file('Edit', join(wt, rel), wt)).toEqual(ALLOW)
      expect(file('Edit', rel, wt)).toEqual(ALLOW)
    })
    // Dani 56096 (2)
    it(`a relative ".." path from the worktree to the install's ${rel} is denied`, () => {
      expect(file('Edit', `../Install/${rel}`, wt)).toEqual(DENY_FILE)
      expect(file('Edit', `${wt}/../Install/${rel}`, wt)).toEqual(DENY_FILE)
    })
    // Dani 56096 (4)
    it(`a different letter case of the install's ${rel} is denied`, () => {
      expect(file('Write', join(base, 'INSTALL', rel.toUpperCase()), wt)).toEqual(DENY_FILE)
    })
  }
  // Dani 56096 (3)
  it('a symlink in the worktree to the install\'s hooks directory is denied', () => {
    symlinkSync(join(root, 'scripts', 'hooks'), join(wt, 'hooks-link'))
    expect(file('Write', join(wt, 'hooks-link', 'x.py'), wt)).toEqual(DENY_FILE)
    expect(bash(`cp /tmp/x.py hooks-link/x.py`, wt)).toEqual(DENY_FILE)
  })
  it('a symlink to the install\'s settings file under another name is denied', () => {
    symlinkSync(join(root, '.claude', 'settings.json'), join(wt, 'innocent.json'))
    expect(file('Write', join(wt, 'innocent.json'), wt)).toEqual(DENY_FILE)
    expect(bash(`echo '{}' > innocent.json`, wt)).toEqual(DENY_FILE)
  })
  it('the root comes from the gate\'s own place, not from the cwd: a worktree cwd does not move it', () => {
    expect(file('Write', join(root, 'store', 'autonomy-config.json'), wt)).toEqual(DENY_FILE)
    expect(file('Write', join(wt, 'store', 'autonomy-config.json'), root)).toEqual(ALLOW)
  })
  it('another file of the install is not protected', () => {
    expect(file('Write', join(root, 'scripts', 'other.py'))).toEqual(ALLOW)
    expect(file('Write', join(root, '.claude', 'agents', 'x.md'))).toEqual(ALLOW)
    expect(file('Write', join(root, 'store', 'other.json'))).toEqual(ALLOW)
  })

  // Bash writes, the same resolution (Dani 56096)
  it.each([
    ['cp', `cp /tmp/x .claude/settings.json`],
    ['mv', `mv /tmp/x scripts/hooks/gate.py`],
    ['tee', `echo '{}' | tee store/autonomy-config.json`],
    ['a redirect', `echo '{}' > store/extra-hooks.json`],
    ['an append', `echo x >> scripts/self-pace-gate.mjs`],
    ['sed -i', `sed -i '' 's/a/b/' .claude/settings.local.json`],
    ['python writing it', `python3 -c "open('store/autonomy-config.json','w').write('{}')"`],
    ['node writing it', `node -e "require('fs').writeFileSync('@ROOT@/.claude/settings.json','{}')"`],
    ['rm of the hooks directory', `rm -rf scripts/hooks`],
    ['rm of its parent', `rm -rf scripts`],
    ['a glob onto the hooks', `rm scripts/ho*/gate.py`],
    ['a brace expansion', `cp /tmp/x .claude/settings{,.local}.json`],
    ['a cd into the hooks first', `cd scripts/hooks && echo x > new.py`],
    ['a path built from a literal variable', `F=.claude/settings.json; cp /tmp/x $F`],
    ['a path from a command substitution', `F=$(echo .claude/settings.json); cp /tmp/x "$F"`],
    ['a path from a command substitution, next to a read of it', `cat .claude/settings.json; F=$(echo .claude/settings.json); cp /tmp/x "$F"`],
    ['a path from a variable with an expansion in it', `F=$PWD/.claude/settings.json; cat .claude/settings.json; cp /tmp/x $F`],
    ['a git checkout of it', `git checkout HEAD -- .claude/settings.json`],
    ['a hook script run with the target as its output', `scripts/hooks/gate.py --out .claude/settings.json`],
    ['a file list piped into xargs', `echo store/autonomy-config.json | xargs rm`],
    ['an unresolved prefix with the protected tail', `cp /tmp/x "$SOMEWHERE/.claude/settings.json"`],
    ['the home-relative absolute path', `cp /tmp/x @ROOT@/store/autonomy-config.json`],
    ['a heredoc body that names it, written to a script file', `cat > /tmp/s.sh <<'EOF'\ncp /tmp/x @ROOT@/.claude/settings.json\nEOF`],
  ])('%s is denied in the install', (_, cmd) => {
    expect(bash(cmd)).toEqual(DENY_FILE)
  })
  it.each([
    ['cp', `cp /tmp/x .claude/settings.json`],
    ['a redirect', `echo '{}' > store/extra-hooks.json`],
    ['sed -i', `sed -i '' 's/a/b/' scripts/hooks/gate.py`],
    ['a cd into the hooks first', `cd scripts/hooks && echo x > new.py`],
  ])('%s passes in the worktree', (_, cmd) => {
    expect(bash(cmd, wt)).toEqual(ALLOW)
  })
  it.each([
    ['cat', `cat .claude/settings.json`],
    ['jq through a pipe', `cat .claude/settings.json | jq .hooks | head -5`],
    ['grep', `grep -n db-write-gate .claude/settings.json scripts/hooks/gate.py`],
    ['diff against the worktree', `diff @ROOT@/.claude/settings.json @WT@/.claude/settings.json`],
    ['git diff', `git diff -- scripts/hooks/`],
    ['git log', `git -C @ROOT@ log --oneline -3 -- .claude/settings.json`],
    ['running a hook script', `python3 scripts/hooks/gate.py --check`],
    ['running the gate module', `node scripts/self-pace-gate.mjs`],
    ['a git pull in the install', `git -C @ROOT@ pull --ff-only`],
    ['a build in the install', `cd @ROOT@ && npm run build`],
    ['a message that names it', `curl -s -X POST http://localhost:3420/api/messages -d '{"content":"I edited @ROOT@/.claude/settings.json"}'`],
    ['a read of it as a message file', `cat @ROOT@/store/autonomy-config.json | jq .levels`],
    ['a write after a cd out of the install', `cd /tmp && echo '{}' > .claude/settings.json`],
  ])('%s passes in the install', (_, cmd) => {
    expect(bash(cmd)).toEqual(ALLOW)
  })
  // Dani 56276 2a: no target directory named -> the cwd is the target
  it.each([
    ['tar -xf', `tar -xf /tmp/x.tar`],
    ['tar xzf (old-style option)', `tar xzf /tmp/x.tgz`],
    ['tar --extract', `tar --extract --file /tmp/x.tar`],
    ['a cd into scripts, then tar', `cd scripts && tar -xf /tmp/x.tar`],
    ['a cd into the hooks, then unzip', `cd scripts/hooks && unzip -o /tmp/x.zip`],
    ['unzip -o', `unzip -o /tmp/x.zip`],
    ['patch -p1 from stdin', `patch -p1 < /tmp/x.patch`],
    ['cpio -i', `cpio -idm < /tmp/x.cpio`],
    ['7z x', `7z x /tmp/x.7z`],
    ['tar with the install as its -C', `tar -xf /tmp/x.tar -C @ROOT@`],
  ])('%s in the install is denied', (_, cmd) => {
    expect(bash(cmd)).toEqual(DENY_FILE)
  })
  it.each([
    ['tar -xf', `tar -xf /tmp/x.tar`],
    ['patch -p1', `patch -p1 < /tmp/x.patch`],
    ['unzip -o', `unzip -o /tmp/x.zip`],
  ])('%s in the worktree passes', (_, cmd) => {
    expect(bash(cmd, wt)).toEqual(ALLOW)
  })
  it.each([
    ['tar -xf into /tmp', `tar -xf /tmp/x.tar -C /tmp/out`],
    ['tar --directory=/tmp', `tar --directory=/tmp/out -xf /tmp/x.tar`],
    ['unzip -d /tmp', `unzip -o /tmp/x.zip -d /tmp/out`],
    ['patch -d /tmp', `patch -d /tmp/out -p1 < /tmp/x.patch`],
    ['7z x -o/tmp', `7z x /tmp/x.7z -o/tmp/out`],
    ['tar -tf (a listing)', `tar -tf /tmp/x.tar`],
    ['tar -xf after a cd out', `cd /tmp && tar -xf /tmp/x.tar`],
  ])('%s from the install passes', (_, cmd) => {
    expect(bash(cmd)).toEqual(ALLOW)
  })
  it('an extraction in an unrelated directory of the install passes (no protected path below it)', () => {
    mkdirSync(join(root, 'workspace'))
    expect(bash(`tar -xf /tmp/x.tar`, join(root, 'workspace'))).toEqual(ALLOW)
  })

  it('a running hook script with the protected path as its OUTPUT is denied', () => {
    expect(bash(`python3 scripts/hooks/gate.py --out .claude/settings.json`)).toEqual(DENY_FILE)
  })
})

// Samu 56294/56299/56310, Dani 56284/56308; the base claim measured on a throwaway clone first
// (probes/gitprobe-2b-1030.txt: a ref rewritten from a worktree is taken by `merge --ff-only origin/develop`, not by
// `pull --ff-only origin develop`; the pull is redirected by url.*.insteadOf from -c, the environment or the user config).
describe('4. git: the main checkout and the remote it pulls from', () => {
  const DENY_GIT = { deny: true, reason: 'git' }
  beforeEach(() => gitScaffold())
  it.each([
    ['the update path', 'git pull --ff-only origin develop'],
    ['the update path, quiet', 'git pull -q --ff-only origin main'],
    ['the update path through -C', 'git -C @ROOT@ pull --ff-only origin develop'],
    ['a fetch', 'git fetch'],
    ['a fetch from origin', 'git fetch origin --prune'],
    ['the host update skill\'s clean-up step', 'git checkout -- package.json package-lock.json'],
    ['a restore with no ref', 'git restore package.json'],
    ['a protected file put back to the reviewed tree', 'git checkout -- .claude/settings.json'],
    ['status', 'git status --porcelain'],
    ['a log', 'git log --oneline -3 -- scripts/hooks/'],
    ['a diff against origin', 'git diff --name-only HEAD origin/develop'],
    ['the remotes', 'git remote -v'],
    ['a config read', 'git config --get remote.origin.url'],
    ['a branch listing', 'git branch -a --contains HEAD'],
    ['a stash listing', 'git stash list'],
    ['a worktree for development', 'git worktree add /tmp/wt-x -b bence/x origin/develop'],
  ])('%s passes in the install', (_, cmd) => {
    expect(bash(cmd)).toEqual(ALLOW)
  })
  it.each([
    ['merge --ff-only origin/<branch> (a worktree can rewrite that ref)', 'git merge --ff-only origin/develop'],
    ['a merge', 'git merge feature'],
    ['reset --hard origin/<branch>', 'git reset --hard origin/main'],
    ['a reset', 'git reset HEAD~1'],
    ['a checkout of a branch', 'git checkout develop'],
    ['a checkout of a ref\'s file', 'git checkout origin/develop -- scripts/x.py'],
    ['a switch', 'git switch develop'],
    ['a rebase', 'git rebase origin/develop'],
    ['a cherry-pick', 'git cherry-pick abc123'],
    ['an apply', 'git apply /tmp/x.patch'],
    ['an am', 'git am /tmp/x.mbox'],
    ['a stash', 'git stash'],
    ['a stash pop', 'git stash pop'],
    ['a clean', 'git clean -fdx'],
    ['a restore from a ref', 'git restore --source=origin/develop scripts/x.py'],
    ['a restore from a ref, short', 'git restore -s HEAD~3 scripts/x.py'],
    ['a pull from another repo', 'git pull --ff-only /tmp/evil develop'],
    ['a pull with a rebase', 'git pull --rebase origin develop'],
    ['a plain pull', 'git pull'],
    ['a pull with an extra refspec', 'git pull --ff-only origin develop main'],
    ['a pull into another ref', 'git pull --ff-only origin develop:x'],
    ['a pull with --upload-pack', 'git pull --ff-only --upload-pack=/tmp/x origin develop'],
    ['a fetch with a refspec', 'git fetch origin develop'],
    ['a fetch of every remote', 'git fetch --all'],
    ['any -c in the install', 'git -c core.pager=cat pull --ff-only origin develop'],
    ['-c url.*.insteadOf (measured: it redirects the pull)', 'git -c url./tmp/evil.insteadOf=https://github.com/ pull --ff-only origin develop'],
    ['-c remote.origin.url', 'git -c remote.origin.url=/tmp/evil pull --ff-only origin develop'],
    ['--config-env', 'git --config-env=url.x.insteadOf=EVIL pull --ff-only origin develop'],
    ['the GIT_CONFIG_* environment (measured: it redirects the pull)', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.x.insteadOf GIT_CONFIG_VALUE_0=y git pull --ff-only origin develop'],
    ['an exported GIT_CONFIG_PARAMETERS', "export GIT_CONFIG_PARAMETERS=\"'url.x.insteadof'='y'\"; git pull --ff-only origin develop"],
    ['GIT_DIR pointing at another repo', 'GIT_DIR=/tmp/evil/.git git status'],
    ['a commit', 'git commit -m x'],
    ['a branch made', 'git branch evil'],
    ['an unknown subcommand (an alias can run anything)', 'git up'],
  ])('%s is denied in the install', (_, cmd) => {
    expect(bash(cmd)).toEqual(DENY_GIT)
  })
  it('the main checkout reached from elsewhere: -C, a subdirectory, --git-dir, an unresolved -C', () => {
    expect(bash('git -C @ROOT@ reset --hard origin/main', wt)).toEqual(DENY_GIT)
    expect(bash('git reset --hard origin/main', join(root, 'scripts'))).toEqual(DENY_GIT)
    expect(bash('git --git-dir=@ROOT@/.git --work-tree=@ROOT@ checkout develop', wt)).toEqual(DENY_GIT)
    expect(bash('git -C "$INSTALL" reset --hard', wt)).toEqual(DENY_GIT)
  })
  it('with no known cwd git counts as the main checkout, unless an absolute -C names another repo', () => {
    const noCwd = (command: string) => gateDecision('Bash', { command: command.replaceAll('@WT@', wt).replaceAll('@ROOT@', root) }, { root })
    expect(noCwd('git commit -m x')).toEqual(DENY_GIT)
    expect(noCwd('git -C @WT@ commit -m x')).toEqual(ALLOW)
    expect(noCwd('git -C @WT@ -C @ROOT@ commit -m x')).toEqual(DENY_GIT)
  })
  it.each([
    ['a commit', 'git commit -m "x"'],
    ['a reset', 'git reset --hard HEAD~1'],
    ['a rebase', 'git rebase origin/develop'],
    ['a checkout of a branch', 'git checkout -b bence/y'],
    ['a merge of origin', 'git merge --ff-only origin/develop'],
    ['a config of its own', 'git config user.name Bence'],
    ['a push of its branch', 'git push -u origin bence/x'],
  ])('%s passes in a worktree', (_, cmd) => {
    expect(bash(cmd, wt)).toEqual(ALLOW)
  })
  it.each([
    ['update-ref onto refs/remotes', 'git update-ref refs/remotes/origin/develop HEAD'],
    ['update-ref --stdin', 'git update-ref --stdin < /tmp/refs'],
    ['a fetch with a refspec onto refs/remotes', 'git fetch /tmp/evil +x:refs/remotes/origin/develop'],
    ['a push into its own refs/remotes', 'git push . HEAD:refs/remotes/origin/develop'],
    ['a branch forced onto an origin name', 'git branch -f origin/develop HEAD'],
    ['a branch moved onto an origin name', 'git branch -M x refs/remotes/origin/develop'],
    ['symbolic-ref onto refs/remotes', 'git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/evil'],
    ['remote.origin.url', 'git config remote.origin.url /tmp/evil'],
    ['remote.origin.fetch', 'git config --add remote.origin.fetch +refs/heads/*:refs/remotes/origin/*'],
    ['core.hooksPath', 'git config core.hooksPath /tmp/hooks'],
    ['include.path', 'git config include.path /tmp/evil.cfg'],
    ['includeIf', 'git config includeIf.gitdir:/Users/.path /tmp/evil.cfg'],
    ['a global insteadOf (measured: it redirects the pull)', 'git config --global url./tmp/evil.insteadOf https://github.com/'],
    ['a system insteadOf', 'git config --system url./tmp/evil.insteadOf https://github.com/'],
    ['the new config syntax', 'git config set --global url./tmp/evil.insteadOf https://github.com/'],
    ['a config edit', 'git config --global --edit'],
    ['remote set-url', 'git remote set-url origin /tmp/evil'],
    ['remote rename', 'git remote rename origin old'],
    ['remote add origin', 'git remote add origin /tmp/evil'],
    ['-c with a remote key', 'git -c remote.origin.url=/tmp/evil fetch origin'],
  ])('%s is denied in a worktree too', (_, cmd) => {
    expect(bash(cmd, wt)).toEqual(DENY_GIT)
  })
  it.each([
    ['the main checkout\'s .git/config', 'echo x >> @ROOT@/.git/config'],
    ['its packed-refs', 'cp /tmp/p @ROOT@/.git/packed-refs'],
    ['a remote-tracking ref file', 'echo abc > @ROOT@/.git/refs/remotes/origin/develop'],
    ['a hook of the main checkout', 'cp /tmp/h @ROOT@/.git/hooks/pre-commit'],
    ['the user\'s git config', 'echo x >> ~/.gitconfig'],
    ['the user\'s XDG git config', 'echo x >> ~/.config/git/config'],
  ])('a write of %s is denied', (_, cmd) => {
    expect(bash(cmd, wt)).toEqual(DENY_FILE)
  })
  it('the file tools on the git wiring are denied, and a read passes', () => {
    expect(file('Edit', join(root, '.git', 'config'), wt)).toEqual(DENY_FILE)
    expect(file('Write', join(root, '.git', 'hooks', 'post-merge'), wt)).toEqual(DENY_FILE)
    expect(bash('cat @ROOT@/.git/config', wt)).toEqual(ALLOW)
  })
  it('the deny text names the rescue section by its file', () => {
    expect(GIT_GATE_MSG).toContain('docs/db-write-gate.md')
    expect(GIT_GATE_MSG).toContain('Vesz-helyreallitas')
    expect(INSTALL_FILE_GATE_MSG).toContain('docs/db-write-gate.md')
    expect(readFileSync(join(REPO, 'docs', 'db-write-gate.md'), 'utf-8')).toMatch(/^## Vész-helyreállítás$/m)
  })
})

describe('the gate itself', () => {
  it('an exception inside the decision is a deny', () => {
    const v = gateDecision('Bash', { command: { toString() { throw new Error('boom') } } }, { cwd: root, root })
    expect(v.deny).toBe(true)
  })
  it('both messages state the limit: a text-based brake, not an OS boundary, and the mxd store', () => {
    for (const m of [DB_GATE_MSG, INSTALL_FILE_GATE_MSG]) {
      expect(m).toMatch(/szoveg-alapu fek, NEM OS-hatar/)
      expect(m).toMatch(/GROMZODONTES1030/)
      expect(m).toMatch(/mxd/)
    }
    const src = readFileSync(HOOK, 'utf-8')
    expect(src).toMatch(/TEXT-BASED BRAKE, NOT AN\s*\/\/\s*OS BOUNDARY/)
  })
  it('the hook process prints a deny for a security-table write and allows a plain command', () => {
    const run = (payload: unknown) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf-8' })
    const d = run({ tool_name: 'Bash', cwd: REPO, tool_input: { command: `sqlite3 ${DB} "DELETE FROM device_keys"` } })
    expect(d.status).toBe(0)
    expect(JSON.parse(d.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
    const w = run({ tool_name: 'Write', cwd: '/tmp', tool_input: { file_path: join(REPO, 'store', 'autonomy-config.json'), content: '{}' } })
    expect(JSON.parse(w.stdout).hookSpecificOutput.permissionDecisionReason).toBe(INSTALL_FILE_GATE_MSG)
    const a = run({ tool_name: 'Bash', cwd: REPO, tool_input: { command: 'ls -la' } })
    expect(a.status).toBe(0)
    expect(a.stdout).toBe('')
    const n = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf-8' })
    expect(n.status).toBe(0)
    expect(n.stdout).toBe('')
  })
  it('the self-pace gate (sub-agents) keeps its own schedule-surface reading', () => {
    expect(selfPaceDecision('Bash', { command: `sqlite3 ${DB} "UPDATE approvals SET status=1"` }, { cwd: root }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: `sqlite3 ${DB} "UPDATE scheduled_tasks SET x=1"` }, { cwd: root }).deny).toBe(true)
  })
})

describe('wiring', () => {
  it('the main agent\'s tracked settings carry the gate, fail-closed, on every tool it guards', () => {
    const s = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf-8'))
    const entries = s.hooks.PreToolUse.filter((e: unknown) => JSON.stringify(e).includes('db-write-gate.mjs'))
    expect(entries).toHaveLength(1)
    expect(entries[0].matcher).toBe('Bash|Write|Edit|MultiEdit|NotebookEdit')
    const cmd = entries[0].hooks[0].command as string
    expect(cmd).toContain('command -v node >/dev/null 2>&1 || {')
    expect(cmd).toContain('node "$CLAUDE_PROJECT_DIR/scripts/hooks/db-write-gate.mjs"')
    expect(cmd).toContain('exit 2; }; exit "$rc"')
  })
  it('a sub-agent gets one entry with the same matcher, and a second inject does not add one', () => {
    const s: Record<string, unknown> = {}
    injectDbWriteGate(s)
    injectDbWriteGate(s)
    const ptu = (s.hooks as { PreToolUse: Array<{ matcher: string, hooks: Array<{ command: string }> }> }).PreToolUse
    expect(ptu).toHaveLength(1)
    expect(ptu[0].matcher).toBe(DB_WRITE_GATE_MATCHER)
    expect(DB_WRITE_GATE_MATCHER).toBe('Bash|Write|Edit|MultiEdit|NotebookEdit')
    expect(ptu[0].hooks[0].command).toContain(join('scripts', 'hooks', 'db-write-gate.mjs'))
  })
  it('the scaffold wires it for every sub-agent and the startup migration repairs it (pinned in source)', () => {
    const src = readFileSync(join(REPO, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')
    expect(src).toContain('if (agentGetsGovernanceGates(name)) injectDbWriteGate(existing)')
    expect(src).toContain('if (needDbGate) injectDbWriteGate(settings)')
  })
  it('it is a known hook script and cannot be switched off by an env var', () => {
    expect(KNOWN_HOOK_SCRIPTS).toContain('db-write-gate.mjs')
    expect(readFileSync(join(REPO, 'scripts', 'hooks', 'hook_switches.py'), 'utf-8')).toMatch(/^\s*"db-write-gate",/m)
  })
})
