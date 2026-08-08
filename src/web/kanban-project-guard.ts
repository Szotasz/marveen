// Every card carries a project, or it is not created.
//
// Viktor's house rule (2026-08-08): the cost report attributes spend by
// project, so a card without one is work whose cost cannot be traced. The rule
// lived in a prompt until now -- and the morning-briefing saga, three
// incidents deep, is the standing evidence that a rule written into a prompt
// only binds the sessions that read it. This one moves into the endpoint every
// card creation passes through.
//
// The list of valid project names is DERIVED from the board rather than
// declared here. A hardcoded list would be the same fact in two places: the
// day someone adds a project, the guard would start rejecting real work, and
// the fix would be a code change for what is a data question.

export interface ProjectResolution {
  ok: boolean
  project?: string
  error?: string
}

const blank = (value: unknown) => typeof value !== 'string' || value.trim() === ''

/**
 * Decide the project for a card being created.
 *
 * A subtask inherits from its parent: the breakdown flow creates children
 * without repeating the field, and asking a caller to restate what the parent
 * already says is how the two drift apart.
 *
 * `knownProjects` is only used to make the refusal useful -- it does NOT
 * restrict the value. A new project has to be possible to introduce, and a
 * guard that forbade it would send people back to creating cards by hand.
 */
export function resolveCardProject(
  card: { project?: unknown; parent_id?: unknown },
  context: { parentProject?: string | null; knownProjects?: string[] } = {},
): ProjectResolution {
  if (!blank(card.project)) return { ok: true, project: (card.project as string).trim() }

  if (!blank(card.parent_id)) {
    const inherited = context.parentProject
    if (!blank(inherited)) return { ok: true, project: (inherited as string).trim() }
    // The parent has no project either. Refusing here is right: creating the
    // child would spread the untraceable card rather than stop at one.
    return {
      ok: false,
      error:
        'A szülő kártyának sincs projektje, így a subtask nem örökölhet. ' +
        'Adj meg projektet expliciten (project mező).' +
        projectHint(context.knownProjects),
    }
  }

  return {
    ok: false,
    error:
      'A kártya létrehozásához kötelező a project mező (Viktor házi szabálya, 2026-08-08): ' +
      'projekt nélkül a kártya költsége nem attribuálható.' +
      projectHint(context.knownProjects),
  }
}

/**
 * The names already in use, so the caller can pick one instead of inventing a
 * near-miss ("revenue radar" next to "revenue-radar" is two projects in the
 * report and one in everyone's head).
 */
function projectHint(known?: string[]): string {
  if (!known || known.length === 0) return ''
  return ` Használatban lévő projektek: ${known.join(', ')}.`
}
