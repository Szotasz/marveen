import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

// Eval and a shell's -c code string are parsed again AFTER the
// outer shell expanded them, so the output of a substitution anywhere in eval's words, or in the
// code word of `sh -c`, becomes code the gate cannot see -- in command position or not
// (`eval "echo $(cat f)"` runs `echo; crontab -r` when f holds `; crontab -r`). The same holds for
// a here-string or an unquoted heredoc that a shell without -c reads as its script. Fail-closed
// (a deliberate choice): any substitution there denies, also inside another substitution (x=$(eval "$(cat f)")),
// where scanShellCode's recursion never looks: the code of each outermost $(...), `...` and <(...)
// is decided by decide() again, as a command of its own (x=$(bash -c 'crontab -r') denied nothing).
// An unquoted substitution that a wrapper consumes as an option value or operand, or that env / sudo
// take as NAME=value, is split into words, and a later word becomes the command
// (`timeout $(echo 5 crontab) -r` runs crontab -r).
// What stays allowed: positional arguments after the -c code word, the stdin of `sh -c`, a quoted
// heredoc or literal eval code without substitution, a plain assignment prefix (never split), a quoted
// wrapper value.
const verdict = (command: string) => gateDecision('Bash', { command })
const denied = (cmd: string, reason: string) => {
  const v = verdict(cmd)
  expect({ cmd, deny: v.deny, reason: v.reason }).toEqual({ cmd, deny: true, reason })
}
const hook = (command: string) => {
  const gate = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'self-pace-gate.mjs')
  const out = execFileSync(process.execPath, [gate], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf-8',
  })
  return JSON.parse(out).hookSpecificOutput
}

describe('self-pace-gate: a substitution that eval or a shell parses again', () => {
  it('DENIES a substitution anywhere in the words of eval, also behind -- and inside a substitution', () => {
    for (const cmd of [
      'eval -- "$(cat /tmp/c)"',
      'eval -- $(cat /tmp/c)',
      'eval "echo $(cat /tmp/c)"',
      'eval : "$(cat /tmp/c)"',
      'eval echo `cat /tmp/c`',
      'builtin eval "echo $(cat /tmp/c)"',
      'x=$(eval "$(cat /tmp/c)")',
      'echo "$(eval "$(cat /tmp/c)")"',
      'echo `eval "$(cat /tmp/c)"`',
    ]) {
      denied(cmd, 'dynamic-command')
    }
  })

  it('DENIES a substitution in the code word of sh -c, also inside a substitution', () => {
    for (const cmd of [
      'bash -c "echo $(cat /tmp/c)"',
      'sh -c "x `cat /tmp/c`"',
      'bash -lc "cd $(cat /tmp/c) && ls"',
      'bash -o pipefail -c "echo $(cat /tmp/c)"',
      ': "$(bash -c "$(cat /tmp/c)")"',
      'x=$(sh -c "echo $(cat /tmp/c)")',
      // the code word is the word after the options, whatever it starts with
      'bash -c "-x; echo $(cat /tmp/c)"',
      'bash -c "+x; echo $(cat /tmp/c)"',
    ]) {
      denied(cmd, 'dynamic-command')
    }
  })

  it('DENIES a substitution in a here-string or an unquoted heredoc a shell reads as its script', () => {
    for (const cmd of [
      'bash -s <<< "x $(cat /tmp/c)"',
      'bash <<< "echo $(cat /tmp/c)"',
      'bash <<EOF\necho $(cat /tmp/c)\nEOF',
      'sh <<EOF\nx `cat /tmp/c`\nEOF',
    ]) {
      denied(cmd, 'dynamic-command')
    }
  })

  it('DENIES an unquoted substitution that a wrapper takes as an option value, operand or NAME=value', () => {
    for (const cmd of [
      'timeout $(echo 5 crontab) -r',
      'nice -n $(echo 5 crontab) -r',
      'env X=$(echo 1 crontab) -r',
      'sudo -u $(echo root crontab) -r',
      'stdbuf -o $(echo L crontab) -r',
      'xargs -P$(echo 1 crontab) -r < /dev/null',
    ]) {
      denied(cmd, 'dynamic-command')
    }
  })

  it('DENIES what the code of a substitution runs, decided as a command of its own (eval / sh -c inside $(...))', () => {
    for (const cmd of [
      "x=$(eval 'crontab -r')",
      "x=$(bash -c 'crontab -r')",
      "echo \"$(sh -c 'crontab -r')\"",
      "echo `bash -c 'crontab -r'`",
      "cat <(bash -c 'crontab -r')",
      "echo $(( $(bash -c 'crontab -r') + 1 ))",
    ]) {
      denied(cmd, 'shell-code')
    }
  })

  it('the recursion into a substitution keeps the depth limit: 4 nested levels pass, 5 deny (shell-code-depth)', () => {
    expect(verdict('echo $(echo $(echo $(echo $(date))))').deny).toBe(false)
    denied('echo $(echo $(echo $(echo $(echo $(date)))))', 'shell-code-depth')
  })

  it('the hook denies the new cases as a process, with deny-JSON', () => {
    const e = hook('eval "echo $(cat /tmp/c)"')
    expect(e.permissionDecision).toBe('deny')
    expect(e.permissionDecisionReason).toContain('a parancs NEVE helyettesitesbol jon')
    expect(hook("x=$(bash -c 'crontab -r')").permissionDecision).toBe('deny')
  })

  // A substitution in a shell's own option range (its options, an option value, the -c bundle
  // word, the script operand) can bring the -c and the code itself: `bash $(cat f)` with f = `-c crontab${IFS}-r`
  // runs crontab, and so does `bash "$(cat f)" 'crontab -r'` with f = `-c` (the next word becomes the code word).
  // Each o / O of an option bundle takes the next word as its value (`bash -xo pipefail "$(cat f)" 'crontab -r'`), and
  // so does --rcfile / --init-file: a value is no operand, the range goes on (and a later -c is found).
  // The option range ends at `--` or after the first operand; what comes after it is never an option. That option
  // grammar is the one of bash / rbash / sh / dash; another shell has options of its own that take a value
  // (`fish -C true "$(cat f)" 'crontab -r'`), so in its words any substitution denies.
  it('DENIES a substitution in the option range of a shell, quoted or not, up to the script operand', () => {
    for (const cmd of [
      'bash $(cat /tmp/c)',
      'bash -$(cat /tmp/c)',
      'sh $(cat /tmp/c) -c ls',
      'bash -o $(cat /tmp/c) -c ls',
      'bash -c$(cat /tmp/c) ls',
      'timeout 5 bash $(cat /tmp/c)',
      "bash \"$(cat /tmp/c)\" 'crontab -r'",
      'x=$(bash $(cat /tmp/c))',
      'bash $(git rev-parse --show-toplevel)/x.sh',
      'bash "$(pwd)/x.sh"',
      "bash -xo pipefail \"$(cat /tmp/c)\" 'crontab -r'",
      "bash +O extglob \"$(cat /tmp/c)\" 'crontab -r'",
      'bash -eo pipefail -c "echo $(cat /tmp/c)"',
      "bash -oo pipefail errexit \"$(cat /tmp/c)\" 'crontab -r'",
      "bash --rcfile x \"$(cat /tmp/c)\" 'crontab -r'",
      "dash -xo errexit \"$(cat /tmp/c)\" 'crontab -r'",
      "fish -C true \"$(cat /tmp/c)\" 'crontab -r'",
      "zsh -o x \"$(cat /tmp/c)\" 'crontab -r'",
      'ksh x.sh "$(cat /tmp/c)"',
    ]) {
      denied(cmd, 'dynamic-command')
    }
  })

  it('INVARIANT: after -- or after the script operand a substitution in the words of a shell stays allowed', () => {
    for (const cmd of [
      'bash -- "$(pwd)/x.sh"',
      'bash -- $(git rev-parse --show-toplevel)/x.sh --check',
      'bash x.sh $(pwd)',
      'bash -x x.sh "$(pwd)"',
      "bash -c 'echo \"$1\"' _ $(pwd)",
      'bash -o pipefail x.sh "$(pwd)"',
      'bash -O extglob x.sh $(pwd)',
      "bash -eo pipefail -c 'echo \"$1\"' _ \"$(pwd)\"",
      'bash -oo pipefail errexit x.sh "$(pwd)"',
      'bash --rcfile x x.sh "$(pwd)"',
      'dash x.sh "$(pwd)"',
    ]) {
      expect({ cmd, deny: verdict(cmd).deny }).toEqual({ cmd, deny: false })
    }
  })

  it('INVARIANT: what the shell does not parse again stays allowed', () => {
    for (const cmd of [
      'bash -c \'echo "$1"\' _ "$(cat /tmp/c)"',
      "bash -c 'ls' <<< \"$(date)\"",
      "eval 'echo hi'",
      'eval echo "$HOME"',
      'bash script.sh "$(pwd)"',
      "bash <<'EOF'\necho $(date)\nEOF",
      'cat <<< "$(date)"',
      'cat <<EOF\n$(date)\nEOF',
      'echo "$(date)" | bash -c \'cat\'',
      'X=$(echo 1 crontab) ls',
      'timeout 5 ls "$(pwd)"',
      'sudo -u "$(whoami)" ls',
      'env X="$(date)" ls',
      'nice -n "$(echo 5)" ls',
      'x=$(bash -c \'echo hi\')',
      'curl -s -H "Authorization: Bearer $(cat /tmp/tok)" http://localhost:3420/api/kanban',
      'n=$(grep -c crontab notes.txt)',
    ]) {
      expect({ cmd, deny: verdict(cmd).deny }).toEqual({ cmd, deny: false })
    }
  })
})
