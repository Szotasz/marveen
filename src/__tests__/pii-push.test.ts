/**
 * The git half of the personal-data gate, against REAL repositories: what a push
 * publishes, and what the installed pre-push hook does with it.
 *
 * Two layers, because they fail differently:
 *  - `runPushed` / `outgoingCommits` called directly (fast, and the only place the
 *    visibility probe can be stubbed);
 *  - the hook INSTALLED by `install-secret-gate-hook.sh` into a throwaway repo and
 *    driven by real `git push`. That is the layer that proves the gate sees a push
 *    whatever its command-line spelling, which is the whole reason it is a hook.
 *
 * Personal-data literals are assembled at run time (`j`): this file is pushed too.
 * The installer is only ever run against a TEMP copy of the scripts: run against the
 * real checkout it would write hooks into the shared .git of every worktree.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, symlinkSync, existsSync, readFileSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseGithubRemote, parseRefLines, probeVisibility, runPushed, splitByMarker, outgoingCommits,
} from '../security/pii-push.js';

const REPO = process.cwd();
const j = (...p: string[]) => p.join('');
const PERSON = j('kovacs.ilona', '@', 'gmail.com');
const HOMEPATH = j('/ho', 'me/', 'bartok', '/work');
const ZERO = '0'.repeat(40);

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

function newRepo(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', j('dev', '@', 'example.com')]);
  git(dir, ['config', 'user.name', 'Dev']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

function commit(dir: string, file: string, content: string, msg = 'change'): string {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), content);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

const refLine = (local: string, remote = ZERO, ref = 'refs/heads/topic') => `${ref} ${local} ${ref} ${remote}\n`;

let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'pii-push-')); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

// ── pure helpers ────────────────────────────────────────────────────────────

describe('parseGithubRemote', () => {
  it.each([
    'https://github.com/o/r.git', 'https://github.com/o/r', 'git@github.com:o/r.git',
    'ssh://git@github.com/o/r.git', 'https://x-access-token:abc@github.com/o/r.git', 'https://github.com/o/r/',
  ])('reads %s', (u) => {
    expect(parseGithubRemote(u)).toEqual({ owner: 'o', repo: 'r' });
  });
  it.each(['/srv/git/r.git', 'file:///srv/r', 'https://gitlab.com/o/r.git', 'https://github.com.evil.io/o/r'])(
    'refuses a non-github target: %s', (u) => { expect(parseGithubRemote(u)).toBeNull(); });
});

describe('parseRefLines', () => {
  it('parses the hook stdin and rejects a malformed line instead of skipping it', () => {
    expect(parseRefLines(refLine('a'.repeat(40)))).toHaveLength(1);
    expect(() => parseRefLines('refs/heads/x onlythree fields\n')).toThrow(/unparseable/);
  });
});

describe('probeVisibility (anonymous; unknown is never private)', () => {
  const url = 'https://github.com/o/r.git';
  const reply = (status: number, body: unknown = {}) => async () => ({ status, json: async () => body });
  it('200 + private:false -> public', async () => {
    expect((await probeVisibility(url, reply(200, { private: false }))).state).toBe('public');
  });
  it('404 -> private (not anonymously readable)', async () => {
    expect((await probeVisibility(url, reply(404))).state).toBe('private');
  });
  it.each([403, 429, 500, 502])('HTTP %i -> unknown', async (code) => {
    expect((await probeVisibility(url, reply(code))).state).toBe('unknown');
  });
  it('200 with a body that does not say private:false -> unknown', async () => {
    expect((await probeVisibility(url, reply(200, {}))).state).toBe('unknown');
  });
  it('a thrown error -> unknown, not private', async () => {
    const boom = async () => { throw new TypeError('fetch failed'); };
    expect((await probeVisibility(url, boom)).state).toBe('unknown');
  });
  it('a stalled request is abandoned by the timeout -> unknown', async () => {
    const hang = (_u: string, init?: { signal?: AbortSignal }) =>
      new Promise<never>((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    expect((await probeVisibility(url, hang as never, 30)).state).toBe('unknown');
  });
  it('a non-github remote is unknown and never queried', async () => {
    let called = false;
    const spy = async () => { called = true; return { status: 404, json: async () => ({}) }; };
    expect((await probeVisibility('/srv/git/r.git', spy)).state).toBe('unknown');
    expect(called).toBe(false);
  });
  it('sends no credential', async () => {
    let seen: Record<string, string> | undefined;
    await probeVisibility(url, async (_u, init) => { seen = init?.headers; return { status: 404, json: async () => ({}) }; });
    expect(Object.keys(seen ?? {}).map((k) => k.toLowerCase())).not.toContain('authorization');
  });
});

describe('splitByMarker', () => {
  const M = 'PIIGATE-test-';
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const C = 'c'.repeat(40);
  it('keeps a record that follows an EMPTY one (the merge-without-diff regression)', () => {
    const out = `${M}${A}\n${M}${B}\n\ndiff --git a/f b/f\n+x\n${M}${C}\n`;
    const m = splitByMarker(out, M);
    expect([...m.keys()]).toEqual([A, B, C]);
    expect(m.get(A)).toBe('');
    expect(m.get(B)).toContain('diff --git');
  });
  it('a marker-looking string inside a body (not at a line start, wrong token) is not a boundary', () => {
    const out = `${M}${A}\n+see ${M}${B} inline\n`;
    expect([...splitByMarker(out, M).keys()]).toEqual([A]);
  });
});

// ── runPushed against real repos ────────────────────────────────────────────

describe('runPushed', () => {
  it('passes a clean push and says how many commits it looked at', async () => {
    const dir = newRepo(tmp, 'clean');
    const base = commit(dir, 'a.txt', 'one\n');
    const head = commit(dir, 'b.txt', 'two\n');
    const r = await runPushed({ remoteName: 'origin', remoteUrl: '/x', stdin: refLine(head, base, 'refs/heads/main'), cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(r.report).toMatch(/1 outgoing commit/);
    expect(r.report).toMatch(/PASS/);
  });

  it('blocks an added e-mail and never prints it', async () => {
    const dir = newRepo(tmp, 'email');
    const base = commit(dir, 'a.txt', 'one\n');
    const head = commit(dir, 'c.txt', `owner: ${PERSON}\n`);
    const r = await runPushed({ remoteName: 'origin', remoteUrl: '/x', stdin: refLine(head, base), cwd: dir });
    expect(r.exitCode).toBe(1);
    expect(r.report).toMatch(/BLOCKED/);
    expect(r.report).toMatch(/c\.txt:1\s+\[email\]/);
    expect(r.report).not.toContain('kovacs');
    expect(r.report).not.toContain('gmail');
  });

  it('judges the pushed COMMITS, not the net diff: added then removed is still published', async () => {
    const dir = newRepo(tmp, 'addremove');
    const base = commit(dir, 'a.txt', 'one\n');
    commit(dir, 'a.txt', `one\n${HOMEPATH}\n`);
    const head = commit(dir, 'a.txt', 'one\n');
    const r = await runPushed({ remoteName: 'origin', remoteUrl: '/x', stdin: refLine(head, base), cwd: dir });
    expect(r.exitCode).toBe(1);
    expect(r.report).toMatch(/\[local-path\]/);
  });

  it('does NOT punish the repair: a deleted line carrying personal data passes', async () => {
    const dir = newRepo(tmp, 'repair');
    const base = commit(dir, 'a.txt', `one\n${PERSON}\n`);
    const head = commit(dir, 'a.txt', 'one\n');
    const r = await runPushed({ remoteName: 'origin', remoteUrl: '/x', stdin: refLine(head, base), cwd: dir });
    expect(r.exitCode).toBe(0);
  });

  it('reads an added line that starts with "++" (the scan.ts blind spot)', async () => {
    const dir = newRepo(tmp, 'plusplus');
    const base = commit(dir, 'a.md', 'head\n');
    const head = commit(dir, 'a.md', `head\n++ ${PERSON}\n`);
    const r = await runPushed({ remoteName: 'origin', remoteUrl: '/x', stdin: refLine(head, base), cwd: dir });
    expect(r.exitCode).toBe(1);
    expect(r.report).toMatch(/a\.md:2\s+\[email\]/);
  });

  it('scans the commit MESSAGE, but exempts a Co-Authored-By trailer address', async () => {
    const dir = newRepo(tmp, 'message');
    const base = commit(dir, 'a.txt', 'one\n');
    const trailerOnly = commit(dir, 'b.txt', 'x\n', `fix\n\nCo-Authored-By: Dev <${PERSON}>`);
    const ok = await runPushed({ remoteName: 'origin', remoteUrl: '/x', stdin: refLine(trailerOnly, base), cwd: dir });
    expect(ok.exitCode).toBe(0);
    const head = commit(dir, 'c.txt', 'y\n', `fix\n\nreproduced in ${HOMEPATH}`);
    const bad = await runPushed({ remoteName: 'origin', remoteUrl: '/x', stdin: refLine(head, base), cwd: dir });
    expect(bad.exitCode).toBe(1);
    expect(bad.report).toMatch(/commit message:3\s+\[local-path\]/);
  });

  it('a new branch is judged on its own commits when its base is already on the remote', async () => {
    const dir = newRepo(tmp, 'newbranch');
    commit(dir, 'old.txt', `legacy ${PERSON}\n`);
    const remote = join(tmp, 'newbranch-remote.git');
    git(tmp, ['init', '-q', '--bare', remote]);
    git(dir, ['remote', 'add', 'origin', remote]);
    git(dir, ['push', '-q', '--no-verify', 'origin', 'main']);
    git(dir, ['checkout', '-q', '-b', 'topic']);
    const head = commit(dir, 'new.txt', 'clean\n');
    const r = await runPushed({ remoteName: 'origin', remoteUrl: remote, stdin: refLine(head), cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(r.report).toMatch(/1 outgoing commit/);
  });

  it('a branch deletion publishes nothing and passes', async () => {
    const dir = newRepo(tmp, 'delete');
    const base = commit(dir, 'a.txt', 'one\n');
    const r = await runPushed({ remoteName: 'origin', remoteUrl: '/x', stdin: `refs/heads/topic ${ZERO} refs/heads/topic ${base}\n`, cwd: dir });
    expect(r.exitCode).toBe(0);
  });

  it('FAIL-CLOSED: a ref line git cannot resolve blocks instead of passing', async () => {
    const dir = newRepo(tmp, 'unresolvable');
    commit(dir, 'a.txt', 'one\n');
    const r = await runPushed({ remoteName: 'origin', remoteUrl: '/x', stdin: refLine('1234567890'.repeat(4)), cwd: dir });
    expect(r.exitCode).toBe(2);
    expect(r.report).toMatch(/fail-closed/);
  });

  it('FAIL-CLOSED: a malformed exception table blocks', async () => {
    const dir = newRepo(tmp, 'badexc');
    const base = commit(dir, 'a.txt', 'one\n');
    const head = commit(dir, 'b.txt', 'two\n');
    const r = await runPushed({
      remoteName: 'origin', remoteUrl: '/x', stdin: refLine(head, base), cwd: dir,
      exceptions: [{ path: 'a', sha256: 'nothex', reason: 'x' }],
    });
    expect(r.exitCode).toBe(2);
  });

  it('applies an exception to exactly one literal and reports it', async () => {
    const dir = newRepo(tmp, 'exc');
    const base = commit(dir, 'a.txt', 'one\n');
    const head = commit(dir, 'doc.md', `maintainer ${PERSON}\n`);
    const { piiHash } = await import('../security/pii-gate.js');
    const r = await runPushed({
      remoteName: 'origin', remoteUrl: '/x', stdin: refLine(head, base), cwd: dir,
      exceptions: [{ path: 'doc.md', sha256: piiHash(PERSON), reason: 'the maintainer address published in the README' }],
    });
    expect(r.exitCode).toBe(0);
    expect(r.report).toMatch(/Exceptions applied \(1\)/);
  });

  it('a local denylist catches a NAME, and a rule that does not compile blocks', async () => {
    const dir = newRepo(tmp, 'denylist');
    const base = commit(dir, 'a.txt', 'one\n');
    const head = commit(dir, 'n.txt', 'written by Teszt Elek\n');
    writeFileSync(join(dir, '.git', 'hooks', 'pii-denylist.txt'), '# names\nteszt elek\n');
    const hit = await runPushed({ remoteName: 'origin', remoteUrl: '/x', stdin: refLine(head, base), cwd: dir });
    expect(hit.exitCode).toBe(1);
    expect(hit.report).toMatch(/\[denylist\]/);
    expect(hit.report).toMatch(/local denylist loaded/);
    writeFileSync(join(dir, '.git', 'hooks', 'pii-denylist.txt'), 're:(broken\n');
    const broken = await runPushed({ remoteName: 'origin', remoteUrl: '/x', stdin: refLine(head, base), cwd: dir });
    expect(broken.exitCode).toBe(2);
  });

  it('says out loud that names are not detected when there is no denylist', async () => {
    const dir = newRepo(tmp, 'nodenylist');
    const base = commit(dir, 'a.txt', 'one\n');
    const head = commit(dir, 'b.txt', 'two\n');
    const r = await runPushed({ remoteName: 'origin', remoteUrl: '/x', stdin: refLine(head, base), cwd: dir });
    expect(r.report).toMatch(/NAMES are not detected/);
  });

  it('reports a binary change as NOT scanned instead of staying silent', async () => {
    const dir = newRepo(tmp, 'binary');
    const base = commit(dir, 'a.txt', 'one\n');
    writeFileSync(join(dir, 'i.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 0]));
    git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'bin']);
    const head = git(dir, ['rev-parse', 'HEAD']).trim();
    const r = await runPushed({ remoteName: 'origin', remoteUrl: '/x', stdin: refLine(head, base), cwd: dir });
    expect(r.report).toMatch(/binary change\(s\) were NOT scanned/);
  });

  describe('the target decides severity, and only a POSITIVE answer relaxes it', () => {
    const ghUrl = 'https://github.com/o/r.git';
    const run = async (fetchImpl: never) => {
      const dir = newRepo(tmp, `vis-${Math.random().toString(36).slice(2, 8)}`);
      const base = commit(dir, 'a.txt', 'one\n');
      const head = commit(dir, 'b.txt', `x ${PERSON}\n`);
      return runPushed({ remoteName: 'origin', remoteUrl: ghUrl, stdin: refLine(head, base), cwd: dir, fetchImpl });
    };
    const reply = (status: number, body: unknown = {}) => (async () => ({ status, json: async () => body })) as never;
    it('public -> BLOCK', async () => {
      const r = await run(reply(200, { private: false }));
      expect(r.exitCode).toBe(1);
      expect(r.report).toMatch(/target PUBLIC/);
    });
    it('private (404) -> loud WARNING, push allowed', async () => {
      const r = await run(reply(404));
      expect(r.exitCode).toBe(0);
      expect(r.report).toMatch(/WARNING \(private target/);
      expect(r.report).toMatch(/\[email\]/);
    });
    it('rate-limited (403) -> unknown -> BLOCK (never fail-open)', async () => {
      const r = await run(reply(403));
      expect(r.exitCode).toBe(1);
      expect(r.report).toMatch(/target UNKNOWN/);
    });
    it('network error -> unknown -> BLOCK', async () => {
      const r = await run((async () => { throw new TypeError('fetch failed'); }) as never);
      expect(r.exitCode).toBe(1);
    });
  });

  it('outgoingCommits excludes what the remote already has, including other tracked branches', () => {
    const dir = newRepo(tmp, 'outgoing');
    commit(dir, 'a.txt', 'one\n');
    const remote = join(tmp, 'outgoing-remote.git');
    git(tmp, ['init', '-q', '--bare', remote]);
    git(dir, ['remote', 'add', 'origin', remote]);
    git(dir, ['push', '-q', '--no-verify', 'origin', 'main']);
    git(dir, ['checkout', '-q', '-b', 'topic']);
    commit(dir, 'b.txt', 'two\n');
    const head = commit(dir, 'c.txt', 'three\n');
    const list = outgoingCommits({ localRef: 'refs/heads/topic', localSha: head, remoteRef: 'refs/heads/topic', remoteSha: ZERO }, 'origin', dir);
    expect(list).toHaveLength(2);
  });
});

// ── the INSTALLED hook, driven by real `git push` ───────────────────────────

describe('installed pre-push hook (real git push, every spelling)', () => {
  let work: string;
  let remote: string;
  let root: string;

  /** A temp "install": a copy of the gate's code in its own repo, with the installer run there. */
  beforeAll(() => {
    root = join(tmp, 'install');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    git(tmp, ['init', '-q', '-b', 'main', root]);
    git(root, ['config', 'user.email', j('dev', '@', 'example.com')]);
    git(root, ['config', 'user.name', 'Dev']);
    cpSync(join(REPO, 'scripts', 'secret-gate.ts'), join(root, 'scripts', 'secret-gate.ts'));
    cpSync(join(REPO, 'scripts', 'install-secret-gate-hook.sh'), join(root, 'scripts', 'install-secret-gate-hook.sh'));
    cpSync(join(REPO, 'src', 'security'), join(root, 'src', 'security'), { recursive: true });
    symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'));
    const inst = spawnSync('bash', [join(root, 'scripts', 'install-secret-gate-hook.sh')], { cwd: root, encoding: 'utf8' });
    expect(inst.status).toBe(0);

    remote = join(tmp, 'hook-remote.git');
    git(tmp, ['init', '-q', '--bare', remote]);
    work = root; // push from the install repo itself: its .git/hooks is the one just written
    writeFileSync(join(work, '.gitignore'), 'node_modules\n');
    git(work, ['remote', 'add', 'origin', remote]);
    commit(work, 'README.md', 'hello\n', 'init');
    const first = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: work, encoding: 'utf8' });
    expect(first.status).toBe(0);
  });

  const push = (args: string[], cwd = work) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const out = (r: ReturnType<typeof push>) => `${r.stdout}${r.stderr}`;

  it('writes the dispatcher and the personal-data member', () => {
    expect(existsSync(join(work, '.git', 'hooks', 'pre-push'))).toBe(true);
    const member = join(work, '.git', 'hooks', 'pre-push.d', '15-personal-data-gate');
    expect(existsSync(member)).toBe(true);
    expect(readFileSync(member, 'utf8')).not.toMatch(/SKIP_|ALLOW_|bypass/i);
  });

  it('lets a clean push through', () => {
    git(work, ['checkout', '-q', '-b', 'clean-1']);
    commit(work, 'ok.txt', 'fine\n');
    const r = push(['push', '-q', 'origin', 'clean-1']);
    expect(r.status).toBe(0);
  });

  it('blocks `git push origin <branch>` carrying personal data', () => {
    git(work, ['checkout', '-q', '-b', 'dirty-1', 'main']);
    commit(work, 'oops.txt', `mail ${PERSON}\n`);
    const r = push(['push', 'origin', 'dirty-1']);
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/BLOCKED/);
    expect(out(r)).not.toContain('kovacs');
    expect(git(remote, ['branch', '--list', 'dirty-1']).trim()).toBe('');
  });

  it('blocks the same content under other spellings of push', () => {
    // HEAD:refs/heads/x, git -C <dir> push, an alias, and a script that calls git
    const a = push(['push', 'origin', 'HEAD:refs/heads/spelled-a']);
    expect(a.status).not.toBe(0);
    const b = push(['-C', work, 'push', 'origin', 'HEAD:spelled-b'], tmp);
    expect(b.status).not.toBe(0);
    git(work, ['config', 'alias.sendit', 'push origin HEAD:spelled-c']);
    const c = push(['sendit']);
    expect(c.status).not.toBe(0);
    const script = join(tmp, 'pusher.sh');
    writeFileSync(script, '#!/bin/sh\ncd "$1" && git push origin HEAD:spelled-d\n');
    chmodSync(script, 0o755);
    const d = spawnSync(script, [work], { encoding: 'utf8' });
    expect(d.status).not.toBe(0);
    for (const n of ['spelled-a', 'spelled-b', 'spelled-c', 'spelled-d']) {
      expect(git(remote, ['branch', '--list', n]).trim()).toBe('');
    }
  });

  it('blocks personal data that lives only in the commit message', () => {
    git(work, ['checkout', '-q', '-b', 'msg-1', 'main']);
    commit(work, 'clean.txt', 'fine\n', `note\n\nsee ${HOMEPATH}`);
    expect(push(['push', 'origin', 'msg-1']).status).not.toBe(0);
  });

  it('passes the repair: removing the data in a follow-up commit on a CLEAN branch', () => {
    git(work, ['checkout', '-q', '-b', 'fix-1', 'main']);
    commit(work, 'fix.txt', 'clean\n');
    expect(push(['push', '-q', 'origin', 'fix-1']).status).toBe(0);
  });

  it('is fail-closed: if the gate cannot run, the push does not go', () => {
    git(work, ['checkout', '-q', '-b', 'closed-1', 'main']);
    commit(work, 'c.txt', 'clean\n');
    const runner = join(work, 'scripts', 'secret-gate.ts');
    const saved = readFileSync(runner);
    rmSync(runner);
    try {
      const r = push(['push', 'origin', 'closed-1']);
      expect(r.status).not.toBe(0);
      expect(out(r)).toMatch(/BLOCKING \(fail-closed\)/);
    } finally {
      writeFileSync(runner, saved);
    }
  });

  it('still lets a deletion of a remote branch through', () => {
    expect(push(['push', '-q', 'origin', '--delete', 'clean-1']).status).toBe(0);
  });
});
