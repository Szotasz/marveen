import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

// A scheduler command name the shell reads after quote and backslash removal is the same command:
// 'crontab' -r, "crontab" -r, cr''ontab -r and c\rontab -r all run crontab. The OS-scheduler rule
// matches the masked text (quoted = data), so a quoted or escaped NAME passed (measured on the base,
// on main 017bc9d6 and on develop 312627675). A
// plain $VAR command word whose only value in the same command is a literal assignment is resolved to
// that literal (X=crontab; $X -r). A quoted NAME in an argument, a heredoc body or a message stays data.
// PARTIAL by design: a name glued from several variables or copied through another variable
// (X=cron; Y=tab; "$X$Y") is not resolved -- an accepted limit.
const verdict = (command: string) => gateDecision('Bash', { command })
const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'self-pace-gate.mjs')

describe('self-pace-gate: a quoted, escaped or literal-variable scheduler name', () => {
  it('DENIES the scheduler when its command word is quoted, glued from quotes or backslash-escaped', () => {
    for (const cmd of [
      "'crontab' -r",
      '"crontab" -r',
      "cr''ontab -r",
      'cr""ontab -l',
      'c\\rontab -r',
      "'at' now",
      '"batch"',
      "sudo 'crontab' -r",
      "ls; 'crontab' -e",
      "true && \"crontab\" -r",
      "env 'crontab' -r",
    ]) {
      expect(verdict(cmd).deny, cmd).toBe(true)
    }
  })

  it('DENIES a $VAR command word whose value in the same command is a literal scheduler name', () => {
    for (const cmd of [
      'X=crontab; $X -r',
      'X=crontab; "$X" -r',
      "X='crontab'; ${X} -r",
      'X=crontab\n$X -l',
    ]) {
      expect(verdict(cmd).deny, cmd).toBe(true)
    }
  })

  it('DENIES a literal-variable name inside shell code handed to another shell (eval, sh -c, $(...))', () => {
    for (const cmd of [
      "X=crontab; eval '$X -r'",
      "X=crontab bash -c '$X -r'",
      'X=crontab; echo $($X -r)',
    ]) {
      expect(verdict(cmd).deny, cmd).toBe(true)
    }
  })

  it('DENIES a ${X:-literal} / ${X-literal} / ${X:=literal} default-value command word', () => {
    for (const cmd of ['${X:-crontab} -r', '${X-crontab} -r', '${X:=crontab} -r']) {
      expect(verdict(cmd).deny, cmd).toBe(true)
    }
  })

  it('DENIES a quoted scheduler name behind a reserved word ({, then, do, !)', () => {
    for (const cmd of [
      "{ 'crontab' -r; }",
      "if true; then 'crontab' -r; fi",
      "for i in a; do 'crontab' -r; done",
      "! 'crontab' -r",
    ]) {
      expect(verdict(cmd).deny, cmd).toBe(true)
    }
  })

  // the "matches only because of the dequoting" check is made on the text the plain rule sees (masked),
  // so a quoted decoy elsewhere in the raw segment does not switch the new rule off
  it('DENIES a quoted scheduler name even when a quoted decoy in the same segment spells the plain name', () => {
    for (const cmd of [
      `'crontab' -r 2>"/tmp/a;crontab"`,
      `'crontab' -r >"/tmp/x;crontab -l"`,
    ]) {
      expect(verdict(cmd).deny, cmd).toBe(true)
    }
  })

  // every literal a name was EVER given counts (not only the last one), and shell code handed to another
  // shell sees the values of its own segment, not the state at the end of the command
  it('DENIES a variable that held a scheduler literal on any path, and code run before a later reassignment', () => {
    for (const cmd of [
      'X=crontab; false && X=ls; $X -r',
      "X=crontab; eval '$X -r'; X=ls",
      "X=crontab; bash -c '$X -r'; X=ls",
    ]) {
      expect(verdict(cmd).deny, cmd).toBe(true)
    }
  })

  // ${X:-lit} with X set to the empty string is the literal
  it('DENIES ${X:-literal} when X is known to be empty', () => {
    for (const cmd of ["X=; ${X:-crontab} -r", "X=''; ${X:-crontab} -r", 'X=""; ${X:-crontab} -r']) {
      expect(verdict(cmd).deny, cmd).toBe(true)
    }
  })

  // the new rule only adds a deny when the dequoting or the resolution made
  // the match; the plain spelling keeps the old rule's read-listing exemption, and a non-scheduler literal stays allowed
  it('ALLOWS the plain read-listing and a non-scheduler literal variable', () => {
    for (const cmd of ['crontab -l', "sh -c 'crontab -l'", 'X=ls; $X -l', 'X=; ${X:-ls} -l']) {
      expect(verdict(cmd).deny, cmd).toBe(false)
    }
  })

  it('ALLOWS the same words as data: an argument, a quoted message, a heredoc body, a non-scheduler variable', () => {
    for (const cmd of [
      "echo 'crontab -r'",
      'grep -n crontab notes.md',
      'git commit -m "remove the crontab -r example"',
      "cat <<'EOF' > /tmp/notes.txt\ncrontab -r\nEOF",
      'X=crontab; echo "$X"',
      'EDITOR=vim; "$EDITOR" notes.md',
      "printf '%s\\n' crontab",
    ]) {
      expect(verdict(cmd).deny, cmd).toBe(false)
    }
  })
})

describe('self-pace-gate hook process: the quoted scheduler name through the real hook entry point', () => {
  const run = (command: string) => spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    timeout: 20000,
  })

  it('prints a PreToolUse deny for a quoted scheduler name and nothing for its data form', () => {
    const d = run("'crontab' -r")
    expect(d.status === 2 || /"permissionDecision"\s*:\s*"deny"/.test(String(d.stdout))).toBe(true)
    const a = run("echo 'crontab -r'")
    expect(a.status).toBe(0)
    expect(String(a.stdout).trim()).toBe('')
  })
})
