---
name: memoria-konzisztencia
description: Once, after the update - the memory store compared with the rule files (CLAUDE.md, SKILL.md), and fixed
---

This task runs ONCE: the install has just taken the version that brought the "When a fact changes" rule, and
for that the existing memory store has to be measured against the rule files once. After its first successful
run the runner switches it off by itself; it does not come back.

First look for an `<install>/store/memoria-konzisztencia-*/STATE.md` that is not `done`. If there is one, an
earlier pass stopped halfway or is still running: do not start a new one, just tell the owner where it stands,
and that the rest has to be asked for by hand.

The runner's quota gate already looked at the token budget before starting. If the budget runs low mid-way,
stop, save the state in the working folder's `STATE.md`, and tell the owner where you are; do not restart from
scratch. Every other rule and gate of yours holds as always.

Load and carry out the `memoria-szabaly-konzisztencia` skill. This run does not write into a rule file
(CLAUDE.md, SKILL.md), and retracts no memory: the changes and the retraction list go to the owner as
proposals. At the end, one short report to the owner on your channel, with numbers: proposed for retraction per
owner (you ask for one yes for it), the proposal file's path and its item count.

If the pass stops halfway (budget, an error, a restart), the partial results and `STATE.md` are in the working
folder: tell the owner where it stands, and that the rest has to be asked for by hand, because this task does
not start again by itself.
