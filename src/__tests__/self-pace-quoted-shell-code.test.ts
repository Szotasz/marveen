import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, systemctlArmsTimer } from '../../scripts/self-pace-gate.mjs'

// Shell code that bash hands to another shell (sh -c CODE, eval WORDS, a here-string
// or heredoc read by a shell) is decided like a command of its own, so a scheduler
// hidden in quotes is denied. tmux takes an alias or any unambiguous prefix of a
// command name, and `\;` chains a second tmux command into the same invocation.
const deny = (command: string): boolean => gateDecision('Bash', { command }).deny

describe('self-pace-gate: a scheduler inside shell code', () => {
  it('DENIES a scheduler in the -c code of a shell', () => {
    for (const cmd of [
      "sh -c 'crontab -r'",
      'bash -c "crontab -l | crontab -"',
      "bash -lc 'at now + 1 minute'",
      "dash -c 'echo x | batch'",
      "zsh -c 'systemd-run --user --on-active=5m true'",
      "ksh -c 'launchctl load x.plist'",
      "sh -c 'cd /w && crontab -r'",
      "/bin/sh -c 'crontab -r'",
      "bash -ec 'crontab -r'",
      "bash -x -c 'crontab -r'",
      "bash -o errexit -c 'crontab -r'",
      "bash -c -- 'crontab -r'",
      "bash -c 'crontab -r' arg0",
      // bash long options that take a value
      "bash --rcfile /dev/null -c 'crontab -r'",
      "bash --init-file /dev/null -c 'crontab -r'",
      // tmux's own global -c runs a shell command through the default shell
      "tmux -c 'crontab -r'",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES it behind a wrapper command', () => {
    for (const cmd of [
      "env sh -c 'crontab -r'",
      "sudo -u x bash -c 'crontab -r'",
      "timeout 5 sh -c 'crontab -r'",
      "nice -n 19 bash -c 'crontab -r'",
      "xargs -I{} sh -c 'crontab -r'",
      "find . -exec sh -c 'crontab -r' \\;",
      "npm test && sh -c 'crontab -r'",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES it in eval, in nested shell code, and in a here-string or heredoc read by a shell', () => {
    for (const cmd of [
      "eval 'crontab -r'",
      'eval crontab -r',
      'eval "at now"',
      `sh -c "sh -c 'crontab -r'"`,
      `bash -c "eval 'crontab -r'"`,
      "sh <<< 'crontab -r'",
      'bash <<EOF\ncrontab -r\nEOF',
      "bash <<'EOF'\nat now + 1 minute\nEOF",
      'sh -s <<EOF\ncrontab -r\nEOF',
      "bash -c $'crontab\\x20-r'",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES it on a later line when the quote-aware splitter gives up (a here-string)', () => {
    for (const cmd of [
      "cat <<< 'a'\nsh -c 'crontab -r'",
      "cat <<< 'a'\neval 'crontab -r'",
      "cat <<< 'a'\ntmux send -t x hi",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
    expect(deny("cat <<< 'a'\nnpm test")).toBe(false)
  })

  it('denies past the nesting limit and allows within it', () => {
    expect(deny('eval eval eval eval true')).toBe(false)
    expect(deny('eval eval eval eval eval true')).toBe(true)
  })

  it('ALLOWS shell code that schedules nothing, and quoted prose that is not shell code', () => {
    for (const cmd of [
      "bash -c 'npm test'",
      "sh -c 'crontab -l'",
      "bash -lc 'cd /w && npx vitest run'",
      'bash <<EOF\nnpm test\nEOF',
      // every code route has a harmless case, so a deny there cannot come from an error
      "bash <<< 'npm test'",
      "tmux -c 'echo hi'",
      "echo 'crontab -r'",
      "grep -n 'at now' notes.txt",
      `printf '%s\\n' "sh -c 'crontab -r'"`,
      'git log --grep="crontab -r"',
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })
})

describe('self-pace-gate: shell grammar around the command word', () => {
  it('DENIES eval after a reserved word or inside a group', () => {
    for (const cmd of [
      "if true; then eval 'crontab -r'; fi",
      "for i in 1; do eval 'crontab -r'; done",
      "! eval 'crontab -r'",
      "time eval 'crontab -r'",
      "{ eval 'crontab -r'; }",
      "(eval 'crontab -r')",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES a shell, tmux or systemctl command inside a ( ) subshell', () => {
    for (const cmd of [
      "(sh -c 'crontab -r')",
      '(tmux send -t x hi)',
      '(systemctl --user start x.timer)',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES when a redirection is glued to a word or stands before the command word', () => {
    for (const cmd of [
      "sh<<<'crontab -r'",
      'bash<<EOF\ncrontab -r\nEOF',
      "bash 2>/dev/null <<< 'crontab -r'",
      'tmux 2>/dev/null send -t x hi',
      'tmux >/dev/null send -t x hi',
      'tmux -S /x/s 2>&1 send -t x hi',
      'tmux send>/dev/null -t x hi',
      'systemctl --user start x.timer>/dev/null',
      'systemctl --user 2>/dev/null start x.timer',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES it when a trailing comment holds an apostrophe', () => {
    for (const cmd of [
      "sh -c 'crontab -r' # don't",
      "tmux send -t x hi # it's fine",
      "systemctl --user start x.timer # don't",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('ALLOWS redirections around harmless commands, and eval outside command position', () => {
    for (const cmd of [
      "npm test # don't",
      "tmux ls # it's fine",
      "systemctl --user status x.timer # don't",
      'systemctl --user start web.service >/tmp/x.timer',
      'tmux -S /x/s list-panes 2>/dev/null',
      'systemctl --user status x.timer 2>/dev/null',
      "bash -c 'npm test' >/tmp/x 2>&1",
      'grep -rn eval src',
      '(cd /w && npm test)',
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })
})

describe('self-pace-gate: review round 1, second reviewer', () => {
  it('DENIES eval at any word position, and the code of trap', () => {
    for (const cmd of [
      "f() { eval 'crontab -r'; }; f",
      "case x in a) eval 'crontab -r';; esac",
      "time -p eval 'crontab -r'",
      "command -p eval 'crontab -r'",
      "trap 'crontab -r' EXIT",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES an ANSI-C quoted or brace-expanded word next to a shell, tmux or systemctl', () => {
    for (const cmd of [
      "$'tmux' send -t x hi",
      "$'sh' -c 'crontab -r'",
      "sh $'-c' 'crontab -r'",
      "{sh,-c,'crontab -r'}",
      '{tmux,send,-t,x,hi}',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES code a shell or source reads from stdin, and the -c code of other shells', () => {
    for (const cmd of [
      'bash /dev/stdin <<EOF\ncrontab -r\nEOF',
      'bash - <<EOF\ncrontab -r\nEOF',
      '. /dev/stdin <<EOF\ncrontab -r\nEOF',
      'source /dev/stdin <<EOF\ncrontab -r\nEOF',
      "fish -c 'crontab -r'",
      "csh -c 'crontab -r'",
      "tcsh -c 'crontab -r'",
      "mksh -c 'crontab -r'",
      "rbash -c 'crontab -r'",
      "yash -c 'crontab -r'",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('ALLOWS the harmless forms of the same routes', () => {
    for (const cmd of [
      "trap 'rm -f /tmp/x' EXIT",
      '. /dev/stdin <<EOF\nnpm test\nEOF',
      "fish -c 'npm test'",
      "cat <<< 'a'\nbash -c 'cd /w && npm test'",
      "cp x.{js,map} /tmp/out",
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })
})

describe('self-pace-gate: review round 2', () => {
  it('DENIES an encoded or brace-built command word', () => {
    for (const cmd of [
      "$'\\x73h' -c 'crontab -r'",
      "$'\\x74mux' send -t x hi",
      "$'\\145val' 'crontab -r'",
      "$'sys\\x74emctl' --user start x.timer",
      "s{h,} -c 'crontab -r'",
      't{mux,} send -t x hi',
      "ev{al,} 'crontab -r'",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES a heredoc or here-string read by a shell or . whatever the operand', () => {
    for (const cmd of [
      'bash /dev/./stdin <<EOF\ncrontab -r\nEOF',
      'bash //dev/stdin <<EOF\ncrontab -r\nEOF',
      '. /dev/./stdin <<EOF\ncrontab -r\nEOF',
      'bash /proc/$$/fd/0 <<EOF\ncrontab -r\nEOF',
      "bash /dev/fd/3 3<<<'crontab -r'",
      "bash --rcfile /dev/stdin -i /dev/null <<'EOF'\ncrontab -r\nEOF",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES the code options of fish, a bash option bundle ending in o, and trap --', () => {
    for (const cmd of [
      "fish -C true -c 'crontab -r'",
      "fish --command 'crontab -r'",
      "fish --command='crontab -r'",
      "fish -C 'crontab -r'",
      "bash -eo pipefail -c 'crontab -r'",
      "trap -- '-; crontab -r' EXIT",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES a systemctl option value that looks like a verb', () => {
    for (const cmd of [
      'systemctl --user -o cat start x.timer',
      'systemctl --user -p status start x.timer',
      'systemctl --user --property status start x.timer',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('ALLOWS ordinary commands with braces, $-quotes, eval or systemctl as data', () => {
    for (const cmd of [
      'chmod +x scripts/{build,deploy}.sh',
      'git add scripts/{a,b}.sh',
      'cp deploy.sh{,.bak}',
      "git commit -m $'Fix flaky test\\n\\nupdate build.sh'",
      "git commit -m $'fix: bash prompt'",
      'cp systemctl.log x.{js,map} /tmp/out',
      "printf '%s\\n' eval 'crontab -r'",
      "echo eval 'crontab -r'",
      'systemctl --user restart ${UNIT}.service',
      'trap - EXIT',
      'bash script.sh <<EOF\nnpm test\nEOF',
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })

  it('DENIES a fish -c inside an option bundle or joined to its code, and eval run by git bisect', () => {
    for (const cmd of [
      "fish -ic 'crontab -r'",
      "fish -lc 'crontab -r'",
      "fish -iC 'crontab -r'",
      "fish -c'crontab -r'",
      "fish -C'crontab -r' -c true",
      "git bisect run eval 'crontab -r'",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('ALLOWS harmless fish code in an option bundle, and git commands that only name eval', () => {
    for (const cmd of [
      "fish -ic 'npm test'",
      "fish --no-config -c 'npm test'",
      'git grep -n eval src/',
      'git log --oneline -S eval',
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })

  it('DENIES a hidden command word behind a wrapper or an assignment, and a -c bundle with an o value', () => {
    for (const cmd of [
      "env $'\\x73h' -c 'crontab -r'",
      "sudo s{h,} -c 'crontab -r'",
      "X=1 $'\\x73h' -c 'crontab -r'",
      'LC_ALL=C t{mux,} send -t x hi Enter',
      "bash -co pipefail 'crontab -r'",
      "bash -eco pipefail 'crontab -r'",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES a heredoc or here-string read by fish when only init code (-C, --init-command) is given', () => {
    for (const cmd of [
      "fish -C 'echo init' <<'EOF'\ncrontab -r\nEOF",
      "fish -iC 'echo init' <<< 'crontab -r'",
      "fish --init-command 'echo init' <<'EOF'\ncrontab -r\nEOF",
      "fish --init-command='echo init' <<< 'crontab -r'",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
    expect(deny("fish -C 'echo init' <<'EOF'\nnpm test\nEOF")).toBe(false)
  })

  it('DENIES . or source in command position reading a heredoc or here-string', () => {
    for (const cmd of [
      "X=1 . /dev/stdin <<< 'crontab -r'",
      "if true; then . /dev/stdin <<< 'crontab -r'; fi",
      "time source /dev/stdin <<< 'crontab -r'",
      "sudo source /dev/stdin <<'EOF'\ncrontab -r\nEOF",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('ALLOWS a heredoc next to . or source used as data, and next to fish --command', () => {
    for (const cmd of [
      "git -C . commit -F - <<'EOF'\nfix: x\n\ncrontab entries are now blocked\nEOF",
      "git log --grep source <<'EOF'\ncrontab -r\nEOF",
      "fish --command 'echo ok' <<'EOF'\ncrontab -r\nEOF",
      "fish --command='echo ok' <<< 'crontab -r'",
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })

  it('ALLOWS trap - with signal names after it (a lone - resets them, nothing runs)', () => {
    expect(deny("trap - 'crontab -r'")).toBe(false)
  })

  it('systemctlArmsTimer: a brace-expanded unit after an arm verb can be a timer', () => {
    const w = (value: string, brace = false) => ({ value, brace })
    expect(systemctlArmsTimer([w('systemctl'), w('--user'), w('start'), w('x.{timer,service}', true)])).toBe(true)
    expect(systemctlArmsTimer([w('systemctl'), w('--user'), w('start'), w('x.service')])).toBe(false)
  })

  it('DENIES a hidden command word after a reserved word or an opening brace', () => {
    for (const cmd of [
      "if true; then s{h,} -c 'crontab -r'; fi",
      "{ s{h,} -c 'crontab -r'; }",
      "! s{h,} -c 'crontab -r'",
      'while true; do t{mux,} send -t x hi Enter; done',
      "{ ev{al,} 'crontab -r'; }",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES a fish -c or --command after an option that takes a value', () => {
    for (const cmd of [
      "fish -d config -c 'crontab -r'",
      "fish -p /tmp/prof -c 'crontab -r'",
      "fish -D 3 -c 'crontab -r'",
      "fish --debug config -c 'crontab -r'",
      "fish --profile /tmp/p --command 'crontab -r'",
      // a -c after a non-option word may be a script argument: stdin is still read
      "fish -d config -c 'echo hi' <<< 'crontab -r'",
      "fish -d config --command 'echo hi' <<< 'crontab -r'",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES a bash option bundle with o or O before its end', () => {
    for (const cmd of [
      "bash -oc pipefail 'crontab -r'",
      "bash -Oc extglob 'crontab -r'",
      "bash -eoc pipefail 'crontab -r'",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
    expect(deny("bash -oc pipefail 'npm test'")).toBe(false)
  })
})

describe('self-pace-gate: systemctl arming a timer or path unit', () => {
  it('DENIES a verb that starts or arms a .timer or .path unit', () => {
    for (const cmd of [
      'systemctl --user start x.timer',
      'systemctl --user enable --now x.timer',
      'systemctl --user enable x.timer',
      'systemctl --user restart x.timer',
      'systemctl --user try-restart x.timer',
      'systemctl --user reload-or-restart x.timer',
      'systemctl --user reenable x.timer',
      'systemctl --user start x.path',
      'systemctl --user link /w/x.timer',
      'systemctl start x.timer',
      'sudo systemctl start x.timer',
      'systemctl --user --no-block start x.timer',
      'systemctl --user start a.service x.timer',
      'systemctl --user start "x.timer"',
      "systemctl --user start '*.timer'",
      '/usr/bin/systemctl --user start x.timer',
      "sh -c 'systemctl --user start x.timer'",
      // bash brace expansion, and systemctl's own glob match against loaded units
      'systemctl --user start x.{timer,service}',
      "systemctl --user start 'x.*'",
      'systemctl --user start x.[t]imer',
      // an option value in front of the verb
      'systemctl --user -p Id start x.timer',
      // starting a target pulls in the timers it wants
      'systemctl --user start timers.target',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('ALLOWS reads, stopping a timer, and starting a service', () => {
    for (const cmd of [
      'systemctl --user list-timers',
      'systemctl --user status x.timer',
      'systemctl --user is-active x.timer',
      'systemctl --user cat x.timer',
      'systemctl --user show x.timer -p NextElapseUSecRealtime',
      'systemctl --user stop x.timer',
      'systemctl --user disable x.timer',
      'systemctl --user restart web.service',
      'systemctl --user start x.service',
      'journalctl --user -u x.timer',
      // the verb is status: `start` is just a unit argument here
      'systemctl --user status start x.timer',
      'systemctl --user show -p Id start.timer',
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })
})

describe('self-pace-gate: tmux aliases, prefixes and chained commands', () => {
  it('DENIES every word tmux resolves to send-keys, run-shell, paste-buffer or set-buffer', () => {
    // tmux 3.6 list-commands: an exact name or alias wins, otherwise a prefix that only one
    // command name starts with. `send-` and `set-` are ambiguous there, `set` is set-option.
    for (const word of [
      'send', 'send-k', 'send-key', 'send-keys',
      'ru', 'run', 'run-', 'run-s', 'run-shel', 'run-shell',
      'pa', 'pas', 'paste', 'pasteb', 'paste-b', 'paste-buf', 'paste-buffer',
      'setb', 'set-b', 'set-buf', 'set-buffer',
    ]) {
      expect(deny(`tmux ${word} -t x hi`), word).toBe(true)
    }
  })

  it('DENIES it after global options, a path or a wrapper, and inside shell code', () => {
    for (const cmd of [
      'tmux -S /x/s send -t x hi Enter',
      'tmux -Lfleet send-k -t x hi',
      'tmux -L fleet -f /dev/null run x',
      'tmux -2u run x',
      '/usr/bin/tmux send -t x hi',
      'env tmux send -t x hi',
      "sh -c 'tmux send -t x hi Enter'",
      'bash -c "tmux run x"',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES a pane-injecting command chained with ;', () => {
    for (const cmd of [
      'tmux new-window \\; send -t x hi',
      "tmux new-window ';' send -t x hi",
      'tmux new-window \\; send-keys -t x hi',
      'tmux new-window\\; send -t x hi',
      'tmux -S /x/s select-pane -t 0 \\; run x',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('ALLOWS tmux reads and the same words outside a tmux command position', () => {
    for (const cmd of [
      'tmux ls',
      'tmux -S /x/s capture-pane -p -t x',
      "tmux display -p '#{pane_id}'",
      'tmux set -g mouse on',
      'tmux list-panes -F run',
      'tmux has-session -t send',
      'tmux -S /x/s list-sessions',
      'tmux show-buffer',
      'tmux new-window \\; select-pane -t 0',
      'npm run test',
      'git send-email --dry-run x',
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })
})

// Where a command position can NOT start, and where it can. Measured with a real bash in a Linux
// container: the `touch H` of the first two commands did not create the file H, that of the last two did.
// The substitution scanner must neither invent a command position in a comment or in an unquoted heredoc
// body that merely holds a quote, nor lose the one after the comment's newline or after a `#` in a word.
describe('self-pace-gate: a substitution in command position, comment and heredoc edges', () => {
  it('ALLOWS a substitution after a comment mark and one behind a quote in an unquoted heredoc body', () => {
    for (const cmd of [
      'echo x # ; $(echo touch H)',
      'cat <<EOF\nx" ; $(echo touch H) ; "\nEOF',
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })

  it('DENIES the substitution after the comment ends, and after a # that is part of a word', () => {
    for (const cmd of [
      'echo x # c\n$(echo touch H)',
      'echo a#b ; $(echo touch H)',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })
})

// More shapes of the command-position scan, each measured with a real bash in a Linux
// container (`touch H` stands for the scheduler: the commands below that DENY created the file H, the ones
// that ALLOW did not).
describe('self-pace-gate: a substitution in command position, shell grammar edges', () => {
  it('ALLOWS an arithmetic command, and a QUOTED substitution glued to a wrapper option', () => {
    for (const cmd of [
      '(( $(echo touch H) >= 4 ))',
      'if (( $(echo touch H) < 9 )); then :; fi',
      'env -C"$(echo /tmp)" true',
      // inside [[ ... ]] the && || ( ) join operands, a quoted substitution there is an operand
      '[[ -n "$x" && "$(echo touch H)" == "" ]]',
      '[[ ( -n x || -n y ) && "$(echo touch H)" ]]',
      // a backslash in the TAG quotes it: the body of <<\EOF is data
      'cat <<\\EOF\n$( $(echo touch H) )\nEOF',
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })

  it('DENIES the command position that follows an arithmetic expression, an ANSI-C string or a backtick', () => {
    for (const cmd of [
      '(( x = 1<<9 ))\n$(echo touch H)',
      'echo $[1<<9]\n$(echo touch H)',
      "echo $'\\'' ; $(echo touch H) ; echo $'\\''",
      'echo `\\$(echo touch H)`',
      'echo `\\`echo touch H\\``',
      'echo `true #` ; $(echo touch H)',
      "echo ${x:-$'\\''} ; $(echo touch H) ; echo ${y:-$'\\''}",
      // ]] ends the conditional: what follows && is a command again
      '[[ -n x ]] && $(echo touch H)',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES after a heredoc whose TAG is partly quoted or odd, inside a quoted comsub of a body, and in the wrapper and function forms', () => {
    for (const cmd of [
      'cat <<E"O"F\nEOF\n$(echo touch H)\n',
      "cat <<@@\nit's\n@@\n$(echo touch H)\n",
      'cat <<EOF\n$(echo ")"; $(echo touch H))\nEOF',
      'T=1; timeout $T $(echo touch H)',
      'function f { $(echo touch H); }; f',
      'env -S"$(echo touch H)"',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })
})

// More edges, each measured with a real bash in a container like the cases above.
describe('self-pace-gate: a substitution in command position, more edges', () => {
  it('ALLOWS a shift in an arithmetic loop head, a heredoc that a << really opens, and a quoted odd TAG', () => {
    for (const cmd of [
      'for ((i=0; i<3; i++)); do echo "$(echo touch H)"; done',
      // here the << IS a heredoc (the rest of the input is its body): bash ran nothing
      'let x=1<<1\n$(echo touch H)',
      'echo a[1<<1]\n$(echo touch H)',
      "cat <<$'EOF'\n$(echo touch H)\nEOF\n",
      // a double-quoted TAG makes the body data, too
      'cat <<"EOF"\n$( $(echo touch H) )\nEOF',
      // an index is arithmetic only where an assignment can start; a declaring builtin takes the << as a heredoc
      'declare a[1<<1]=x\n$(echo touch H)',
      'arr[1]=x; echo "$(echo touch H)"',
      'a[$(echo 1)]=x',
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })

  it('DENIES eval after --, a glued ]] separator, an arithmetic << shift, odd quoted TAGs and exec -a', () => {
    for (const cmd of [
      'eval -- "$(echo touch H)"',
      'eval -- $(echo touch H)',
      '[[ -n x ]]&& $(echo touch H)',
      '[[ -z x ]]|| $(echo touch H)',
      '[[ -n x ]]| $(echo touch H)',
      'for ((i=1<<1; i<3; i++)); do :; done\n$(echo touch H)',
      'a[1<<1]=x\n$(echo touch H)',
      'cat <<"E\\"F"\nE"F\n$(echo touch H)\n',
      "cat <<$'EOF'\nEOF\n$(echo touch H)\n",
      'cat <<"E\\\\F"\nE\\F\n$(echo touch H)\n',
      'cat <<$X\nb\n$X\n$(echo touch H)\n',
      'exec -a NAME $(echo touch H)',
      // delta round: a [ after a wrapper, an option value or a redirection target opens no index
      'timeout a[ ; $(echo touch H)',
      'env a[ ; $(echo touch H)',
      '>a[ ; $(echo touch H)',
      'exec -a a[ ; $(echo touch H)',
      // glued loop heads, an ANSI-C TAG with an escape, a combined exec option
      'for((i=1<<1;i<3;i++)); do :; done\n$(echo touch H)',
      'while((1<<1==2)); do break; done\n$(echo touch H)',
      'if((1<<1==2)); then :; fi\n$(echo touch H)',
      "cat <<$'E\\'F'\nE'F\n$(echo touch H)\n",
      "cat <<$'E\\tF'\nE\tF\n$(echo touch H)\n",
      'exec -la NAME $(echo touch H)',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })
})

// Edges of the scan: the redirection may come before the command word, an escaped
// $( in the body of a shell's heredoc is live for that shell, --rcfile / --init-file take a value, and an unquoted
// ${...} splits into words. Measured with a real bash like the cases above.
describe('self-pace-gate: a substitution in command position, plan-delta edges', () => {
  it('ALLOWS an escaped $ that stays text for the shell that reads the heredoc', () => {
    for (const cmd of [
      'bash <<EOF\necho \\$HOME\nEOF',
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })

  it('DENIES a shell script handed over before the command word, with an escaped $(, behind --rcfile, and in an unquoted ${...}', () => {
    for (const cmd of [
      '<<< "$(echo touch H)" bash',
      '<<EOF bash\n$(echo touch H)\nEOF',
      'bash <<EOF\n\\$(echo touch H)\nEOF',
      // the escaped backtick of an unquoted heredoc is live for the shell that reads it as its script
      'bash <<EOF\n\\`echo touch H\\`\nEOF',
      // --rcfile / --init-file take the next word as a value, so the -c after it is still a -c
      'bash --rcfile /dev/null -c "echo $(echo \';touch H\')"',
      'bash --init-file /dev/null -c "echo $(echo \';touch H\')"',
      // each o / O in a -c bundle takes the next word as its value, the code word comes after them
      'bash -oc pipefail "echo $(echo \';touch H\')"',
      'bash -co pipefail "echo $(echo \';touch H\')"',
      'timeout ${x:-$(echo 5 touch)} H',
      'env X=${y:-$(echo 1 touch)} H',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('REFUSES literal scheduler code behind eval -- (not run against a bash: it would be a real crontab)', () => {
    for (const cmd of ["eval -- 'crontab -r'", 'eval -- crontab -r']) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })
})

// Still more edges. Every DENY row below was run against a real bash (the output of the
// substitution ran as a command: `touch H` appeared); every ALLOW row was run too (nothing ran).
describe('self-pace-gate: a substitution in command position, still more edges', () => {
  it('DENIES an unquoted $(...) in the code of a shell, eval or a heredoc it reads (the resolved marker splits into words)', () => {
    for (const cmd of [
      "bash -c 'timeout $(echo 5 touch H) x'",
      "eval 'env X=$(echo Y=1 touch H) x'",
      "bash <<'EOF'\ntimeout $(echo 5 touch H) x\nEOF",
      "bash -c 'timeout ${Z:-$(echo 5 touch H)} x'",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('ALLOWS a quoted $(...) there, and one that is an argument', () => {
    for (const cmd of [
      `bash -c 'timeout "$(echo 5)" true'`,
      "bash -c 'timeout 5 echo $(echo hi)'",
      "bash -c 'timeout \"${Z:-$(echo 5)}\" true'",
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })

  it('DENIES a [[ that is no keyword (quoted, escaped, behind a wrapper or a NAME=value): || and | then end the command', () => {
    for (const cmd of [
      '"[[" x || $(echo touch H)',
      '\\[[ x || $(echo touch H)',
      'env [[ x || $(echo touch H)',
      'command [[ x || $(echo touch H)',
      'builtin [[ x || $(echo touch H)',
      'nohup [[ x || $(echo touch H)',
      'timeout 5 [[ x || $(echo touch H)',
      'sudo [[ x || $(echo touch H)',
      'command time [[ x || $(echo touch H)',
      'X=1 [[ x || $(echo touch H)',
      '"[[" x | $(echo touch H)',
      // only the bare keyword time (with -p at most) leaves it a keyword; a redirection before it makes it a command name
      '/usr/bin/time [[ y || $(echo touch H)',
      '\\time [[ y || $(echo touch H)',
      'time -f x [[ y || $(echo touch H)',
      'time -p -p [[ y || $(echo touch H)',
      '>/dev/null [[ y || $(echo touch H)',
      '2>&1 [[ y || $(echo touch H)',
      '<<E [[ y || $(echo touch H)\nhi\nE',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('ALLOWS a substitution as an operand of a real [[ ]] (also behind time, !, if and {)', () => {
    for (const cmd of [
      '[[ -n x || $(echo touch H) == y ]]',
      'time [[ -n x || $(echo touch H) ]]',
      'time -p [[ -n x || $(echo touch H) ]]',
      'if [[ -n x || $(echo touch H) ]]; then :; fi',
      '! [[ -n x || $(echo touch H) ]]',
      '{ [[ -n x || $(echo touch H) ]]; }',
      // the wrapper / NAME=value of an EARLIER command does not reach the next one
      'env true && [[ -n x || $(echo touch H) ]]',
      'X=1 true; [[ -n x || $(echo touch H) ]]',
      '>/dev/null true; [[ -n x || $(echo touch H) ]]',
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })

  it('DENIES a substitution in the -c bundle word of a shell, glued or quoted', () => {
    for (const cmd of [
      "bash -c$(echo ' touch${IFS}H')",
      // the value word of an o / O of the -c bundle: unquoted, its output (pipefail + the code word) shifts the code word
      "bash -co $(echo 'pipefail touch${IFS}H') 'x'",
      `bash -c"$(echo xe)" 'touch H'`,
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
    expect(deny("bash -c 'echo hi'"), 'bash -c plain').toBe(false)
    // with -c the heredoc is the stdin of the command, not the script of the shell: a substitution in it stays allowed
    expect(deny("bash -lc 'cat' <<EOF\n$(echo hi)\nEOF"), 'bash -lc with a heredoc on stdin').toBe(false)
  })

  it('DENIES a substitution in the action word of trap, which the shell parses again when the signal fires', () => {
    for (const cmd of [
      `trap "echo $(echo ';touch H')" EXIT`,
      `trap -- "echo $(echo ';touch H')" EXIT`,
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
    for (const cmd of ["trap 'rm -f x' EXIT", 'trap - EXIT', 'trap -p', 'trap cleanup EXIT', 'trap "echo done" INT TERM']) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })

  it('DENIES a substitution glued to env -iS / -vS, or in the command word behind env -iu NAME / -vC DIR; ALLOWS the quoted values', () => {
    for (const cmd of [
      'env -iS"$(echo touch H)"',
      'env -vS"$(echo touch H)"',
      'env -iu X "$(echo touch)" H',
      'env -vC . "$(echo touch)" H',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
    for (const cmd of ['env -C"$(pwd)" true', 'env -iu"$(echo X)" true', 'env -iu X true', 'env -vC . true', 'env -iuX echo "$(echo hi)"', 'env -vC. echo "$(echo hi)"']) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })

  it('DENIES a command name after an option value spelled NAME=value (exec -a A=B, xargs -I A=B)', () => {
    for (const cmd of [
      'exec -a A=B "$(echo touch)" H',
      'echo x | xargs -I A=B "$(echo touch)" H',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
    expect(deny('exec -a A=B true'), 'exec -a plain').toBe(false)
  })
})
