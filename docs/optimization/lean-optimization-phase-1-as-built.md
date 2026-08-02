# Lean Optimization Phase 1 — as built

Card: c755f4b2. Branch: `feat/lean-opt-phase1-gate` (worktree `/home/iszzu/marveen-wt/lean-opt-phase1`), based on `2ad7e91` (v1.25.1).
Built by fullstackfejleszto, 2026-07-29. Gated by marveen.

This document records what was actually built, including the parts that were
scoped OUT mid-build. It is not a plan.

## Scope as it ended up

Phase 1 started as two blocks. Partway through, Istvan removed the privacy
enforcement half from active scope.

| Block | Intended | Actual outcome |
|---|---|---|
| A — data-sensitivity gate | build + flip to ENFORCE | **Built, PARKED at observe-only.** Not merged, not deployed, ENFORCE never flipped. |
| B — neutral model profiles | build + canary | **Built and accepted**, additive, resolved-model diff empty. |

Reason for the Block A change (owner decision, 2026-07-29): no customer PII is
handled during development, and the primary operator input path is
plugin-injected and cannot be observed from Node (see Known limitations). The
work is parked and resumable, not discarded and not falsely closed.

---

## Block A — data-sensitivity gate (PARKED, observe-only)

Commit `1f762e7`. Mode remains `observe-only` in `store/data-sensitivity-gate.json`.
Nothing in this block blocks a dispatch today.

### Starting state (verified in source, not from the 07-17 audit)

The 07-17 audit's G4 finding was stale — the gate had shipped after it. What
actually existed on `2ad7e91`:

- `src/data-sensitivity-gate.ts`: three categories, 33 regex patterns, pure logic.
- `src/web/data-sensitivity-gate-runner.ts`: config read, env-based provider
  trust, audit write, liveness check.
- `sensitivity_audit_log`: already hash-only, so the "no PII in logs"
  requirement was already satisfied before Phase 1.
- One call site, in `message-router.ts`.

### Deltas found against the audit, and what was done

| Finding | Was | Now |
|---|---|---|
| Categories | 3 (`public`/`internal`/`restricted`) | 4, with `unknown` as its own state |
| `classifyContent` on no-match | returned `public` — **fail-open** | returns `unknown`; only explicit metadata or a policy may declare something public |
| `evaluateDispatch` on a trusted provider | short-circuited and wrote a **false `public`** category to the audit | always classifies; the audit records the real category |
| Verdicts | `allow`/`would_block`/`block` | `pass`/`ask`/`block`, recorded as `would_*` in observe mode |
| Provider trust | `TRUSTED_PROVIDERS` env prefix list, defaulting to `{claude}` | deployment-local, default-DENY per-provider level map |
| Coverage | 1 of 5 content-bearing dispatch paths | all of them, at one choke point |
| Audit CHECK constraint | rejected `unknown` | widened idempotently; historical rows preserved, no backfill |

### Architecture

Classification is metadata-first, detector-second:

```
explicit dispatch metadata          (precedence 1)
  -> explicit kanban card metadata  (precedence 2)
  -> predefined workflow policy     (precedence 3)
  -> deterministic regex detector   (precedence 4, ESCALATE-ONLY)
  -> unknown
```

The detector is a second layer with three hard constraints enforced in code,
not by convention: it can never lower an explicit level, it can never declare
content public, and it emits reason codes rather than matched values. An
explicit `public` label combined with a restricted signal is a *conflict*, not
a quiet escalation, and a conflict is never a silent pass — not even to the
trusted runtime.

`unknown` is its own state in classification and in the audit, so a genuine
restricted hit is distinguishable from "we could not tell". For provider
*eligibility* only, `unknown` is treated fail-closed: it requires a provider
cleared for `restricted`.

### The choke point (the F1 fix)

The gate previously ran at exactly one caller, `message-router.ts`. Merge
`14023f0` rewrote that file and deleted the call. Every test stayed green,
because a never-called gate and an always-passing gate emit the same thing:
silence.

The gate now runs inside `sendPromptToSession` (`src/web/agent-process.ts`),
the single function every dispatch path funnels through — message router,
schedule runner, channel monitor, agent worker, context guard, nudges. All 13
call sites declare what they send. Three things keep it there:

- a `LOCAL-FORK SEAM` marker comment, the convention that let CostOps survive
  the same merge;
- structural tests that fail if the call moves, disappears, or is ordered after
  the first keystroke;
- an hourly PASS beacon in the audit log, so the liveness check reads a real
  signal instead of interpreting silence.

### Provider trust

`store/provider-trust-map.json` — deployment-local, gitignored, no secrets,
policy only. Schema and semantics in `config-examples/provider-trust-map.example.json`.
Keys are lowercased model prefixes, longest match wins; a provider with no
entry is untrusted. Missing or malformed map is fail-closed for every category,
logged at error level, and reported by `GET /api/security/gate-health`.

`unknown` is deliberately not grantable: eligibility for unclassified content
is derived from the `restricted` grant, so only a provider already cleared for
restricted content can receive something the gate could not classify.

### Metadata data path

`kanban_cards.data_sensitivity` and `agent_messages.data_sensitivity`, both
nullable, both without backfill. Guessing a level for hundreds of legacy cards
would manufacture classifications nobody made; absent means unknown, never
public. A card dispatch inherits the card's value and may escalate it, never
relax it. A bad value is a 400 at the API, never a silent fallback.

### Audit log

Metadata only. Beyond the pre-existing fields the table now records decision
provenance: source, explicit and detector categories, conflict flag, attended
flag, reason codes, call site, resolved provider, and config version. It never
stores a prompt, an excerpt, PII, a credential, or the concrete value a pattern
matched. `content_hash` is a SHA-256 for correlation only.

### Evidence

- 51 unit tests, including the false-positive regression set (TAJ/tax-id
  context windows, ISO dates vs card numbers, prod DB names).
- 9 structural wiring guards.
- 19 canaries C1–C4, run against the **real runner** with a fixture non-trusted
  provider: C1 public research passes with zero false positives; C2 restricted
  legal blocks, and the same task passes to the trusted runtime — proving the
  block is about the provider, not about legal work; C3 conflict blocks
  unattended and asks when attended; C4 unattended unknown blocks. Mode
  round-trip and fail-closed trust map covered.
- Both guard families proven able to fail: neutering the eligibility check
  fails 11 tests; removing the gate call fails 3 wiring tests.

---

## Block B — behaviour-neutral model profiles (ACCEPTED)

### Conflict pre-check

`templates/profiles/*.json` and `src/web/profiles.ts` already use the word
"profile", but the evidence is unambiguous that they mean something else: a
`ProfileTemplate` carries `permissionMode` and a filesystem allow/deny list for
Claude Code's permissions engine. It has no model field and no relationship to
model selection. Overloading it would couple two unrelated axes, so per spec
5.1 this is a **separate** `modelProfile` concept with its own map.

### Design

`src/model-profiles.ts` is pure: no fs, no env, no imports from this fork's
config layer. It knows the four profile ids and the resolver; the concrete
mapping is deployment-local. That is what makes it portable upstream.

Resolver precedence: **explicit `model` → `modelProfile` → install default.**

The failure semantics matter more than the happy path. An unknown profile id, a
missing map, or an unusable map must not silently fall through to the default
model — that would move an agent onto a different provider without anyone
choosing it. Those cases resolve to the default *and* carry an `error` that
surfaces in `/api/agents` (`modelProfileError`) and at the API on write (400).

The layer is strictly **additive**. `src/config-registry.ts` and
`src/web/model-suggest.ts` are untouched, and `MODEL_ALIASES` remains the single
alias table — the resolver receives `resolveModelId` as a hook rather than
reimplementing aliasing. Tests assert all of this so a later refactor cannot
quietly turn the addition into a replacement.

### The map

`store/model-profile-map.json`, deployment-local and gitignored; schema in
`config-examples/model-profile-map.example.json`. All four ids must be present —
a partial map is rejected, because a missing entry would resolve that profile to
the install default.

Built from the live fleet snapshot of 2026-07-29 (post-reassignment: 12 agents
on `deepseek-v4-pro`, 7 on `claude-sonnet-5`, 2 on `claude-opus-5`):

| Profile | Resolves to |
|---|---|
| `premium_reasoning` | `claude-opus-5` |
| `build_strong` | `claude-sonnet-5` |
| `analysis_efficient` | `deepseek-v4-pro` |
| `routine_lowcost` | `deepseek-v4-pro` |

Two profiles pointing at the same model is intentional. Phase 1 abstracts; it
does not re-tier.

### Canary result

`buildfejleszto → build_strong` and `research → analysis_efficient`, applied
**additively**: both keep their explicit `model`, so by precedence the profile
is inert and the change is a no-op on the running old build as well as on the
new one.

| | before | after |
|---|---|---|
| buildfejleszto resolved model | `claude-sonnet-5` | `claude-sonnet-5` |
| research resolved model | `deepseek-v4-pro` | `deepseek-v4-pro` |
| `/api/agents` resolved-model diff, all 22 agents | — | **EMPTY** |
| account / `claudeConfigDir` | `/home/iszzu/.claude-personal` | unchanged |
| provider routing | unchanged | unchanged |

Verified twice: against the live dashboard running the old build (which ignores
the new field entirely), and against the new resolver reading the real live
configs and the real map. Both diffs empty across all 22 agents.

The profile-only cutover — removing the explicit `model` so resolution actually
goes through the map — was **not** performed. It resolves to the identical model
(proven in test), but it would be a real behaviour change on the currently
deployed build, which has no profile support. It is marveen's flip after deploy.

### Evidence

30 tests: 21 unit (map validation, precedence, failure semantics, neutrality)
and 9 wiring tests through the real agent-config fs layer, including explicit
assertions that the existing selector is untouched.

---

## Known limitations

1. **Operator-inbound content is not gated, and cannot be from this repo.**
   Inbound Telegram/Slack messages are written into the tmux pane by the channel
   plugin, not through Node — verified independently in `stuck-input-watcher.ts`
   and `pane-state.ts`. Even with ENFORCE on, the gate would close the Node-side
   paths only. Istvan's scope decision (no customer PII during development)
   resolved this as an accepted limitation rather than a blocker. Any future
   claim that the P0 privacy hole is "closed" must exclude this path or be false.
2. **Owner-typed terminal input is outside the gate.** The interactive
   agent-terminal route types directly into a pane via `tmux-keys.ts`. This is
   the owner typing into their own agent, but it is a content path and it is not
   gated. Recorded as an audited exemption in the wiring test rather than left
   implicit.
3. **Block A is parked, not shipped.** Observe-only, unmerged. The privacy hole
   the gate was built to close is still open.
4. **The PASS beacon is hourly.** The liveness check can be up to an hour stale
   on a quiet fleet.

## Rollback

- Block A: not deployed, so rollback is "do not merge". If merged: set `mode`
  to `observe-only`, then `off`, in `store/data-sensitivity-gate.json`. No
  source edit, no restart of the gate module required. Both new columns are
  additive and nullable, so no lossy schema downgrade exists to reverse.
- Block B: delete `modelProfile` from the two canary configs. Their explicit
  `model` is untouched, so resolution returns to exactly today's answer.
  Deleting `store/model-profile-map.json` is also safe while every agent names
  an explicit model.

## Upstream boundary

No issue or PR opened. Local evidence first, and a separate owner GO is
required before publishing.

**Upstream candidates** (generic, no local policy): the `modelProfile` field and
`src/model-profiles.ts` resolver; the generic sensitivity metadata vocabulary;
the dispatch-guard interface and reason codes; a provider-agnostic trust-policy
adapter. Block B is the cleaner candidate of the two — it is pure, additive, and
carries no deployment policy. Check #517 (provider-agnostic routing) for overlap
before proposing.

**Stays local**: the concrete provider trust map, the concrete profile→model
map, accounts, the privacy policy, and the feature-flag state.

## Phase 2 prerequisites

Out of scope here and not started: dynamic per-task routing, automatic provider
fallback, a capacity-state registry, sticky card→runtime routing, CostOps schema
extension, `cost_per_accepted_task`, plan-change advice, market screening.
Phase 2 should not begin until Block A's park/ship question is decided, because
routing decisions and privacy decisions share the same dispatch path.
