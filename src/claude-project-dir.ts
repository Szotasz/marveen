// Claude Code stores a session's transcripts under
// <config root>/projects/<encoded working dir>/. This module is the ONE
// encoder for that directory name; every reader and launcher in the tree
// imports it, so the rule cannot drift again (UTKODOLODIVERG922: two narrower
// rules lived here side by side and agreed only by coincidence).
//
// MEASURED on Claude Code 2.1.278 (2026-09-22): sessions started in scratch
// working directories with a throwaway CLAUDE_CONFIG_DIR, and the directory
// the CLI created read back:
//   .../scratchpad/enc_probe dir+plus@at.v2~x  ->  ...-scratchpad-enc-probe-dir-plus-at-v2-x
//   .../scratchpad/enc__two  sp.éÁ-Z9          ->  ...-scratchpad-enc--two--sp----Z9
// Every character outside [a-zA-Z0-9-] becomes ONE '-': underscore, space,
// '+', '@', '.', '~' and accented letters alike, one dash per code point, no
// run-collapsing, existing dashes kept, the leading '/' included (which is why
// every encoded name starts with '-').
//
// The two rules this replaces -- replace '/' and '.' only, and replace '/'
// only -- give the SAME name for every path made of [a-zA-Z0-9-/.], which is
// every path the fleet had ever run on (/Users/<name>/ClaudeClaw, agents/<id>
// with [a-z0-9-] ids, /root/marveen-develop-test, /home/<user>/marveen). They
// diverge on an underscore, a space or an accented letter in the install path
// or the user name, where they name a directory Claude Code never creates and
// every reader on it (context counter, active model, conversation view,
// inbound probe, --continue decision) silently measures nothing.
//
// Zero imports on purpose: the encoder is pure and must stay trivially
// testable and importable from the launcher, the readers and the tests alike.
export function encodeClaudeProjectDir(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9-]/g, '-')
}
