---
name: reggeli-napindito
description: Reggeli összefoglaló: email, naptár, AI hírek, plus Dream Engine top-of-message
---

Reggeli napindítót a CLAUDE.md formátum szerint. A beállított csatornára (chat_id: 0).

**FONTOS — Dream Engine override**: a napindító ELEJÉRE (még az email/naptár szekciók ELŐTT) tedd be a `{{INSTALL_DIR}}/DREAM.md` fájl tartalmából az 5 bucket-et — `💡 Skill-javaslatok`, `🧹 Memória-egészség`, `🎯 Top-3 holnapi javaslat`, `🌐 External opportunity`, `🛠 Skill-flotta health`. Ha a DREAM.md nem létezik vagy üres (pl. a Dream Engine valamiért nem futott le), kihagyod ezt a szekciót.

A `cat {{INSTALL_DIR}}/DREAM.md` parancs visszaadja a tartalmat, abból emeld ki a kulcs-szekciókat MarkdownV2-formátumra escape-elve.

A többi szekció (email, naptár, AI hírek) maradnak a CLAUDE.md-ben leírt formátum szerint.

**AI hírek szekció -- CSAK a fő-ágensnél ({{MAIN_AGENT_ID}})**: ha NEM a fő-ágensként futsz (azaz sub-agentként), HAGYD KI az "🤖 AI HÍREK" szekciót -- sub-agenteknek nem releváns. Az email és naptár szekció marad mindenkinél.
