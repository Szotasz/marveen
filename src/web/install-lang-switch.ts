// DOCKERUX1118 (owner 33327/33329; Samu 80886, 80891): the setup wizard's language switch on a Docker install. ONE
// language decision: the install's (first-boot's .lang, AGENT_TEXT_LANG); the wizard follows it, and a switch changes
// it, re-rendering what the install wrote from its templates in the new language, but ONLY a file that is untouched.
// The rule everywhere: when in doubt, the file is kept (an edit kept for nothing is cheap, an edit overwritten is not).
//
// - CLAUDE.md and SOUL.md (here, not in scripts/lib/seed-refresh.sh, whose persona branch stays as it is): untouched
//   means that after the dashboard's generated blocks are cut out (they come back, in the new language, when the main
//   agent starts), the text is the old language's template rendered as first-boot renders it, with EITHER the current
//   names, OR the first-boot names (Owner / Marveen) and the wizard's name step applied to it (the same plain
//   replace as renameInPersonaFile: the agent's name, then the owner's). The new render takes the same form, so a
//   switch there and back gives the same bytes. The render is scripts/lib/seed-refresh.sh's render_seed_template,
//   the function render_persona_file writes with, fed what docker/first-boot.sh feeds it.
// - The seeded skills and scheduled tasks: docker/lang-switch-seeds.sh, the image update's seed refresh with the new
//   language (its own untouched rule, either language), one report line per file.
import { join } from 'node:path'

export type InstallLang = 'en' | 'hu'
export type FileOutcome = 're-rendered' | 'kept_customized' | 'unchanged' | 'added'
export interface FileResult {
  /** CLAUDE.md / SOUL.md, or a path under the home (.claude/skills/..., .claude/scheduled-tasks/...). */
  readonly file: string
  readonly result: FileOutcome
}
export type LangSwitchResult =
  | { readonly ok: true; readonly lang: InstallLang; readonly previous: InstallLang; readonly files: readonly FileResult[] }
  | { readonly ok: false; readonly error: 'seed_refresh_failed' | 'render_failed' | 'agent_running'; readonly lang: InstallLang; readonly files: readonly FileResult[] }

export interface RunResult {
  readonly code: number | null
  readonly stdout: string
}

export interface LangSwitchDeps {
  /** The install (PROJECT_ROOT). */
  readonly root: string
  /** The image's own scripts (/opt/marveen-docker). */
  readonly dockerDir: string
  /** The login user's home: the seeded skills and tasks are under its .claude. */
  readonly home: string
  readonly readEnv: (key: string) => string | null
  readonly setEnv: (key: string, value: string) => void
  readonly readFile: (path: string) => string | null
  /** Atomic write. */
  readonly writeFile: (path: string, text: string) => void
  readonly exists: (path: string) => boolean
  /** Start a program without a shell, with exactly this environment. */
  readonly run: (file: string, args: readonly string[], env: Record<string, string>) => Promise<RunResult>
  /** Does the main agent run now? Asked again right before the first write (Dani 80955 n2). */
  readonly agentRunning: () => boolean
}

/** The first-boot names, before the wizard's name step. */
export const FIRST_BOOT_OWNER = 'Owner'
export const FIRST_BOOT_BOT = 'Marveen'

/** The install's language as the persona helper reads it: the key, hu without it. */
export function installLang(readEnv: (key: string) => string | null): InstallLang {
  return readEnv('AGENT_TEXT_LANG') === 'en' ? 'en' : 'hu'
}

/** The template of a persona file in a language, as scripts/lib/persona-template.sh picks it: en only where it exists. */
export function personaTemplate(root: string, name: 'CLAUDE.md' | 'SOUL.md', lang: InstallLang, exists: (p: string) => boolean): string {
  const en = join(root, 'templates', 'en', `${name}.template`)
  return lang === 'en' && exists(en) ? en : join(root, 'templates', `${name}.template`)
}

// The dashboard's generated blocks (agent-scaffold.ts ensure*Section, the egress posture), with the blank lines before
// them: what the dashboard adds to the main CLAUDE.md, never part of a template.
const GENERATED_BLOCK = /\s*<!-- BEGIN (?:GENERATED: [^\n]*?|PER-INSTALL POSTURE[^\n]*?) -->[\s\S]*?<!-- END (?:GENERATED: [^\n]*?|PER-INSTALL POSTURE) -->/g

/** The text without the generated blocks and without trailing white space: what is compared with a render. */
export function personaCore(text: string): string {
  return text.replace(GENERATED_BLOCK, '').trimEnd()
}

/** The wizard's name step on a first-boot render (onboarding.ts renameInPersonaFile, in its order). */
export function applyNameStep(text: string, bot: string, owner: string): string {
  let out = text
  if (bot && bot !== FIRST_BOOT_BOT) out = out.split(FIRST_BOOT_BOT).join(bot)
  if (owner && owner !== FIRST_BOOT_OWNER) out = out.split(FIRST_BOOT_OWNER).join(owner)
  return out
}

// render_seed_template of scripts/lib/seed-refresh.sh over a template ($2), with CLAUDE.md's chat id and time zone as
// docker/first-boot.sh passes them (RENDER_CHAT_ID=0, the install_tz zone or UTC) when PERSONA_CLAUDE_MD=1.
const RENDER_SH = [
  '. "$1" || exit 70',
  'if [ "${PERSONA_CLAUDE_MD:-}" = 1 ]; then',
  '  RENDER_CHAT_ID=0',
  '  RENDER_TIMEZONE="$(. "$INSTALL_DIR/scripts/lib/install-tz.sh"; z="$(install_tz "$INSTALL_DIR")"; printf \'%s\' "${z:-UTC}")"',
  'fi',
  'render_seed_template < "$2"',
].join('\n')

interface Names {
  readonly bot: string
  readonly owner: string
}

async function render(deps: LangSwitchDeps, name: 'CLAUDE.md' | 'SOUL.md', template: string, names: Names): Promise<string | null> {
  const env: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LC_ALL: 'C.UTF-8',
    INSTALL_DIR: deps.root,
    BOT_NAME: names.bot,
    OWNER_NAME: names.owner,
  }
  if (name === 'CLAUDE.md') {
    env.PERSONA_CLAUDE_MD = '1'
    env.MAIN_AGENT_ID = deps.readEnv('MAIN_AGENT_ID') ?? ''
    env.WEB_PORT = deps.readEnv('WEB_PORT') ?? '3420'
  }
  const r = await deps.run('bash', ['-c', RENDER_SH, 'render', join(deps.root, 'scripts', 'lib', 'seed-refresh.sh'), template], env)
  return r.code === 0 && r.stdout.length > 0 ? r.stdout : null
}

type PersonaPlan =
  | { readonly kind: 'unchanged' | 'kept_customized' }
  | { readonly kind: 'write'; readonly text: string }

async function planPersona(deps: LangSwitchDeps, name: 'CLAUDE.md' | 'SOUL.md', from: InstallLang, to: InstallLang): Promise<PersonaPlan | null> {
  const current = deps.readFile(join(deps.root, name))
  if (current === null) return { kind: 'unchanged' }
  const oldTpl = personaTemplate(deps.root, name, from, deps.exists)
  const newTpl = personaTemplate(deps.root, name, to, deps.exists)
  if (oldTpl === newTpl) return { kind: 'unchanged' }
  const now: Names = { bot: deps.readEnv('BOT_NAME') ?? '', owner: deps.readEnv('OWNER_NAME') ?? '' }
  const first: Names = { bot: FIRST_BOOT_BOT, owner: FIRST_BOOT_OWNER }
  const core = personaCore(current)
  const withNow = await render(deps, name, oldTpl, now)
  if (withNow === null) return null
  if (core === withNow.trimEnd()) {
    const text = await render(deps, name, newTpl, now)
    return text === null ? null : { kind: 'write', text }
  }
  const withFirst = await render(deps, name, oldTpl, first)
  if (withFirst === null) return null
  if (core === applyNameStep(withFirst, now.bot, now.owner).trimEnd()) {
    const text = await render(deps, name, newTpl, first)
    return text === null ? null : { kind: 'write', text: applyNameStep(text, now.bot, now.owner) }
  }
  return { kind: 'kept_customized' }
}

/** The seeds' report lines (docker/lang-switch-seeds.sh): "seed <outcome> <path>". */
export function parseSeedReport(stdout: string): FileResult[] {
  const map: Record<string, FileOutcome> = { updated: 're-rendered', kept: 'kept_customized', current: 'unchanged', added: 'added' }
  const out: FileResult[] = []
  for (const line of stdout.split('\n')) {
    const m = /^seed (updated|kept|current|added) (.+)$/.exec(line)
    if (m) out.push({ file: m[2], result: map[m[1]] })
  }
  return out
}

/**
 * Switch the install's language. The caller (the route) has checked the owner, the deployment and the onboarding
 * state. Nothing is written before both persona files are decided; then the language keys, the persona files, the
 * seeds. A seed refresh that does not finish keeps its snapshot, so the container's next start finishes it.
 */
export async function switchInstallLanguage(lang: InstallLang, deps: LangSwitchDeps): Promise<LangSwitchResult> {
  const previous = installLang(deps.readEnv)
  const files: FileResult[] = []
  if (lang === previous) {
    // The language keys only: an install whose .env lost DASHBOARD_LANG gets it back. No file is rendered.
    if (deps.readEnv('DASHBOARD_LANG') !== lang) deps.setEnv('DASHBOARD_LANG', lang)
    return { ok: true, lang, previous, files }
  }
  const plans: Array<['CLAUDE.md' | 'SOUL.md', PersonaPlan]> = []
  for (const name of ['CLAUDE.md', 'SOUL.md'] as const) {
    const plan = await planPersona(deps, name, previous, lang)
    if (plan === null) return { ok: false, error: 'render_failed', lang, files }
    plans.push([name, plan])
  }
  // DOCKERUX1118 n2 (Dani 80955, Samu 80960): the route asked before the renders; the main agent may have been started
  // since (the wizard's launch from another window), and it would load a half-switched CLAUDE.md. Asked again here,
  // right before the first write: a running agent means nothing is written at all.
  if (deps.agentRunning()) return { ok: false, error: 'agent_running', lang, files }
  deps.setEnv('AGENT_TEXT_LANG', lang)
  deps.setEnv('DASHBOARD_LANG', lang)
  deps.writeFile(join(deps.root, '.lang'), lang + '\n')
  for (const [name, plan] of plans) {
    if (plan.kind === 'write') {
      deps.writeFile(join(deps.root, name), plan.text)
      files.push({ file: name, result: 're-rendered' })
    } else {
      files.push({ file: name, result: plan.kind })
    }
  }
  const seeds = await deps.run('bash', [join(deps.dockerDir, 'lang-switch-seeds.sh')], {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LC_ALL: 'C.UTF-8',
    HOME: deps.home,
    MARVEEN_INSTALL_DIR: deps.root,
    MARVEEN_DOCKER_DIR: deps.dockerDir,
  })
  files.push(...parseSeedReport(seeds.stdout))
  if (seeds.code !== 0) return { ok: false, error: 'seed_refresh_failed', lang, files }
  return { ok: true, lang, previous, files }
}
