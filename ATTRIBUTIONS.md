# Attributions

Marveen builds on and incorporates work from several open-source projects and concepts. This file credits those sources.

For the Marveen project's own license, see [LICENSE](./LICENSE) (MIT).

## Bundled / Adapted Code

### Bumblebee (supply-chain hygiene scanner)
- **Source**: https://github.com/perplexityai/bumblebee
- **Author**: Perplexity AI
- **License**: Apache 2.0
- **Where in Marveen**: `seed-scheduled-tasks/bumblebee-hygiene-scan/` (includes the binary, scan profile, and a vendored copy of the threat-intel catalogs at the time of integration)
- **What it does for us**: weekly Monday 09:00 read-only inventory of installed packages, MCP configurations and extensions, matched against the bundled supply-chain threat catalogs. Alerts only on findings.

### Zhutov skill suite (handoff / retrospective / skill-management)
- **Source**: https://artemxtech.substack.com/p/3-claude-code-skills-that-make-claude
- **Author**: Artem Zhutov
- **Where in Marveen**: `seed-skills/handoff/`, `seed-skills/retrospective/`, `seed-skills/skill-management/`
- **What it does for us**: skill scaffolding adapted to Marveen's fleet architecture. The 5-section handoff structure (Goal, Current Progress, What Worked, What Didn't Work, Next Steps), the sub-agent retrospective pattern, and the skill-rot lifecycle management concept all originate from Zhutov's suite. Implementations were rewritten in TypeScript and integrated with Marveen's checkpoint, DREAM, memory, and inter-agent message systems.

### printing-press (agent-CLI generator)
- **Source**: https://github.com/mvanhorn/cli-printing-press
- **Author**: Mike Van Horn
- **Where in Marveen**: used as a generator tool (not bundled) — produces the `skool-cli`, `aiam-blog-pp-cli`, `connectors-hu` CLI bundles wrapped around external APIs, plus the matching Claude Code skill files.

## Conceptual Influence (not bundled code)

### Karpathy CLAUDE.md principles
- **Source**: Andrej Karpathy's CLAUDE.md guidance (public)
- **Where in Marveen**: pattern reference for our own root `CLAUDE.md`. No code copied; the layout and rule-style is influenced by Karpathy's pattern.

### Matt Pocock — "/handoff is my new favourite skill"
- **Source**: https://youtu.be/dtAJ2dOd3ko
- **Where in Marveen**: the "purpose" argument as a mandatory parameter on `/handoff`, and the cross-agent portable design (so a HANDOFF.md works between Claude Code, Codex, Copilot CLI, etc.) was lifted from Matt's design recommendations in the video.

---

If you spot a missing attribution or want a correction, open an issue or a PR on https://github.com/Szotasz/marveen.
