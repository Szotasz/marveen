---
name: memoria-konzisztencia
description: Once, after the update - the memory store compared with the rule files (CLAUDE.md, SKILL.md), and fixed
---

This task runs ONCE: the install has just taken the version that brought the "When a fact changes" rule, and
for that the existing memory store has to be measured against the rule files once. After its first successful
run the runner switches it off by itself; it does not come back.

The runner's quota gate already looked at the token budget before starting: had it been tight, this run would
not have started, and the task would try again the next night. Do not stop here again over the token budget:
if you exit now for that reason, the run counts as done and the task is switched off for good. Every other rule
and gate of yours holds as always.

Load and carry out the `memoria-szabaly-konzisztencia` skill. This run does not write into a rule file
(CLAUDE.md, SKILL.md): changes go to the owner as proposals. At the end, one short report to the owner on your
channel, with numbers: retracted per owner, the proposal file's path and its item count.

If the pass stops halfway (budget, an error, a restart), the partial results are in the working folder: tell the
owner where it stands, and that the rest has to be asked for by hand, because this task does not start again by
itself.
