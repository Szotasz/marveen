import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

// A command NAME that comes out of a substitution is invisible to the gate. The shell runs
// the output of `$(echo crontab -r)` as the command, while the text shows only `echo`; a flat $(...)
// is even replaced by an opaque marker before the segments are parsed. Fail-closed: a substitution
// ($(...), backticks, <(...), bare or inside "...") in a word in command position denies with its own
// reason -- the command word, or the word a wrapper runs. eval runs its arguments, so the output of
// a substitution handed to eval is in command position too, and so is a <(...) that source, `.` or a
// shell reads as code. A substitution as an argument, quoted as an argument, in an assignment (also
// an array literal) or in a heredoc body that no shell reads, and a plain $VAR command word, stay
// allowed.
const verdict = (command: string) => gateDecision('Bash', { command })

describe('self-pace-gate: a substitution in the command position', () => {
  it('DENIES a command name built by a substitution, with the dynamic-command reason', () => {
    for (const cmd of [
      '$(echo crontab -r)',
      '`echo crontab -r`',
      '"$(echo crontab)" -r',
      // not flat (quotes inside): never turned into a marker
      '$(echo "crontab" -r)',
      '"$(printf "%s" crontab)" -r',
      'cron$(echo tab) -r',
      "$(printf 'cron%s' tab) -r",
      '${X:-$(echo crontab)} -r',
      'true && $(echo crontab -r)',
      'echo a | $(echo crontab) -',
      'ls\n$(echo crontab -r)',
      'if $(echo crontab -r); then :; fi',
      '( $(echo crontab -r) )',
      'x=1 $(echo crontab -r)',
      '2>/dev/null $(echo crontab -r)',
      '2>&1 $(echo crontab -r)',
      'timeout 5 $(echo crontab -r)',
      'nice -n 19 $(echo crontab -r)',
      'env FOO=1 $(echo crontab -r)',
      'exec $(echo crontab -r)',
      'xargs -0 $(echo crontab) < /dev/null',
      'echo "$( $(echo crontab -r) )"',
      // shell code handed on (eval, sh -c, a heredoc read by a shell) is decided as a command of its own
      'eval $(echo crontab -r)',
      'eval "$(echo crontab -r)"',
      'eval "$(ssh-agent -s)"',
      "bash -c '$(echo crontab -r)'",
      "bash <<'EOF'\n$(echo crontab -r)\nEOF",
      // source, `.` and a shell read a <(...) as code
      'source <(echo crontab -r)',
      '. <(echo crontab -r)',
      'bash <(echo crontab -r)',
      'bash < <(echo crontab -r)',
      'bash -c "$(echo crontab -r)"',
      // any <(...) of source / . / a shell denies, without modelling the shell's own options (terv-biralat d767e039;
      // D3: bash script.sh < <(...) and bash -n <(...) deny too)
      "bash -n +n <(printf 'crontab -r\\n')",
      "bash -O extglob <(printf 'crontab -r\\n')",
      'bash -- <(echo crontab -r)',
      "/bin/bash run.sh --cmd-stdin < <(printf 'python3 x.py')",
      "bash -n <(sed -n '/^f() {/,/^}/p' lib.sh)",
      'source lib.sh < <(ls)',
      // a << inside quotes is no heredoc; after a real heredoc's TAG line the command position is back
      'echo "<<X"; $(echo crontab -r)',
      "cat <<'EOF'\nx\nEOF\n$(echo crontab -r)",
      // an unquoted heredoc TAG: the body expands, a substitution in it runs (terv-biralat 0603dcfb)
      'cat <<EOF\n$( $(echo crontab -r) )\nEOF',
      'cat <<EOF\nx `$(echo crontab -r)`\n',
      // two heredocs on one line: the second, unquoted body expands
      "cat <<'A' <<B\nx\nA\n$( $(echo crontab -r) )\nB",
      // backslash and quote parity in an unquoted body cannot open a '...' that hides a substitution
      "cat <<EOF\n\\\"x ' $( $(echo crontab -r) ) '\nEOF",
      // an escaped backslash in an unquoted body leaves the substitution after it live
      'cat <<EOF\n\\\\$( $(echo crontab -r) )\nEOF',
      // an unquoted body joins \ + newline before the TAG line is matched: EO\<nl>F ends it (terv-biralat 9b6f4272)
      'cat <<EOF\nEO\\\nF\n$(echo crontab -r)\n',
      'cat <<-EOF\n\tEO\\\nF\n$(echo crontab -r)\n',
      // a wrapper option that takes the next word as its value
      'sudo -u x $(echo crontab -r)',
      'env -u X $(echo crontab -r)',
      'timeout -s KILL 5 $(echo crontab -r)',
      'xargs -I {} $(echo crontab -r)',
      'env -S "$(echo crontab -r)"',
      // the index of an assignment expands too
      'a[$( $(echo crontab -r) )]=x',
      // grammar edges
      '{ $(echo crontab -r); }',
      '! $(echo crontab -r)',
      'f() { $(echo crontab -r); }; f',
      'case x in x) $(echo crontab -r);; esac',
      'coproc $(echo crontab -r)',
      'select x in a; do $(echo crontab -r); done',
      'command -p $(echo crontab -r)',
      'time -p $(echo crontab -r)',
      'exec 3>&1 $(echo crontab -r)',
      '$(<cmd.txt) -r',
    ]) {
      const v = verdict(cmd)
      expect({ cmd, deny: v.deny, reason: v.reason }).toEqual({ cmd, deny: true, reason: 'dynamic-command' })
    }
  })

  it('INVARIANS: still ALLOWS a substitution as an argument, quoted, in an assignment, in data, and a $VAR command word', () => {
    for (const cmd of [
      'curl -q -s -H "Authorization: Bearer $(cat /nonexistent/store/.dashboard-token)" http://localhost:3420/api/kanban',
      's=$(date +%s); echo "$s"',
      'cd "$(git rev-parse --show-toplevel)" && ls',
      'git commit -m "$(cat msg.txt)"',
      'for f in $(ls); do wc -l "$f"; done',
      '[ "$(cat f)" = x ] && echo ok',
      'if [ -n "$(git status --porcelain)" ]; then echo dirty; fi',
      'timeout 300 python3 x.py "$(cat a)"',
      'echo "rc=$(( $(date +%s) - 5 ))"',
      'case "$(uname)" in Darwin) echo mac;; esac',
      'printf "%s\\n" "$(ls)"',
      'echo "== $j: $(cat d/DONE 2>/dev/null || echo fut) | $(tail -1 d/run.log)"',
      "echo '$(this is data)'",
      'ls 2>&1 | grep x',
      'diff <(ls a) <(ls b)',
      'while read l; do echo "$l"; done < <(ls)',
      "cat > /tmp/f <<'EOF'\n$(echo crontab -r)\nEOF",
      "python3 - <<'PY'\n`x`\nPY",
      "cat > /tmp/f <<'EOF'\n$(echo crontab -r)\n",
      'C=($(git rev-list --reverse a..b))',
      'a=1 \\\n  s=$(date) && echo "$s"',
      'true && \\\ns=$(date) && echo "$s"',
      // an unquoted arithmetic is no command position (and no subshell)
      'echo $(( $(date +%s) - 5 ))',
      // a heredoc ends only on the exact TAG line: " EOF" is still body
      "cat <<'EOF'\n EOF\n$(echo crontab -r)\nEOF",
      'cat <<EOF\nDate: $(date)\nEOF',
      "cat <<'A' <<'B'\n$( $(echo crontab -r) )\nA\n$( $(echo crontab -r) )\nB",
      'cat <<E"O"F\n$(date)\nEOF',
      // a quoted TAG joins nothing: EO\<nl>F is body there
      "cat <<'EOF'\nEO\\\nF\n$(echo crontab -r)\nEOF",
      // the bash oracle's own literals (orakulum.py A4, A6), byte for byte
      'cat <<E"O"F\n$(echo crontab -r)\nEOF',
      "cat > /dev/null <<'EOF'\n$(echo crontab -r)\nEOF",
      // in an unquoted body \` and \$ are plain text, as bash leaves them (a real command)
      'cat <<EOF\nnote: \\`\\$(echo crontab -r)\\` stays text\nEOF',
      'sudo -u x ls "$(pwd)"',
      'env -u X ls "$(pwd)"',
      'timeout -s KILL 5 python3 "$(cat a)"',
      'command -v "$(echo python3)"',
      'f() { echo "$(date)"; }; f',
      '{ echo "$(date)"; }',
      '! grep -q "$(cat p)" f',
      'echo $(<file)',
      'exec 3>"$(mktemp)"',
      '$PY script.py',
      '"$NODE" x.mjs',
      'command -v python3',
    ]) {
      expect({ cmd, deny: verdict(cmd).deny }).toEqual({ cmd, deny: false })
    }
  })

  it('the hook prints the dynamic-command message (its own token), not the generic self-pace text', () => {
    const gate = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'self-pace-gate.mjs')
    const out = execFileSync(process.execPath, [gate], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: '$(echo crontab -r)' } }),
      encoding: 'utf-8',
    })
    const h = JSON.parse(out).hookSpecificOutput
    expect(h.permissionDecision).toBe('deny')
    expect(h.permissionDecisionReason).toContain('a parancs NEVE helyettesitesbol jon')
  })

  it('the hook prints nothing and exits 0 on an allowed command', () => {
    const gate = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'self-pace-gate.mjs')
    const out = execFileSync(process.execPath, [gate], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 's=$(date +%s); echo "$s"' } }),
      encoding: 'utf-8',
    })
    expect(out).toBe('')
  })

  it('an unbalanced command with a substitution in command position still denies', () => {
    expect(verdict('$(echo crontab -r) "unterminated').deny).toBe(true)
    expect(verdict("`echo crontab -r` 'unterminated").deny).toBe(true)
  })
})
