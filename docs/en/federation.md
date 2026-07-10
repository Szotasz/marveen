# Federation — connecting Marveen instances

## 🎯 What it does / why it matters

Two (or more) independent Marveen installs — say one on a Mac mini and one on a MacBook — **see each other's agents and send messages/tasks to each other**, while both systems stay fully autonomous. Agents address exactly as before, with the system name prefixed:

```
POST /api/messages   { "from": "marketing", "to": "teodor/backend-dev", "content": "..." }
```

Management lives on the **dashboard's Federation page** (after the Ideabox): master switch, peer add/pairing, tokens, live status, full removal. Federated agents show up in the **Agents view** (dashed cards with a "Message" button) and in the **Messages** sidebar — a conversation can be started without prior history.

**Off by default.** Until you enable it, the system behaves bit-for-bit like the pre-federation build.

## 🛠 How it works

### Architecture

- **Addressing:** `<system>/<agent>`. Both segments strictly `[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}` — anything else is rejected (no Unicode look-alikes, no `..`).
- **Outbound path:** messages enter the usual `agent_messages` queue; the router hands `/`-qualified recipients to the **federation bridge** (5s timeout, per-peer exponential backoff, max 3 attempts per tick). The patience window is **per peer** (`abandonWindowMinutes`, default 60 — give a laptop peer that sleeps a lot more); after it, the message turns `failed`. On success (202): `delivered` + `result: fed:<peer>:<id>`.
- **Inbound path:** the inbox validates token, size (max 64 KB), recipient and sender, then inserts into the local queue as `from: "<peer>/<agent>"` with **verbatim content**. Delivery uses the existing paths (sub-agent: tmux; main agent: drain-inbox pull).
- **Main-agent pickup (pull model + auto-nudge):** the router never injects into the perpetually-busy main channels session — mail addressed to the main agent is pulled at the start of EVERY main-agent turn (UserPromptSubmit hook). So that no human message is needed: a background watcher (inbox nudge) starts a minimal turn when pending mail exists, ONLY while the session is idle — on an idle system pickup is typically within ~a minute; while the session is busy it waits until it frees up (the dashboard's `pending` status stays accurate). If three nudges fail to lead to a pickup, the watcher stops and alerts the owner once (suspected hook breakage).
- **Security framing:** a `/`-qualified sender is the FIRST classification branch — always the `federated` category, wrapped as `<untrusted source="federation:<system>:<agent>">` with the security preamble. The local `POST /api/messages` rejects a `/`-qualified from with 403 (impersonation guard).
- **Dedup:** at-least-once delivery + receiver-side `(authenticated peer, ref)` dedup (peer-token callers only — an owner's curl smoke test cannot poison it).

### Tokens: per peer, both directions

Every peer entry carries TWO tokens in `store/federation.json` (0600):

- **`inboundToken`** — minted by US for the peer; THEY present it to US. It identifies the caller: the sender prefix may only be the authenticated peer's own (cross-peer impersonation is closed).
- **`outboundToken`** — received from the peer; WE present it to THEM. **May be empty** ("pairing in progress") — the bridge then refuses to send and the poller shows `unpaired`.

Rotate with the card's "Rotate token" button: the new token is valid immediately, the old one invalid immediately — **the peer side must update too**; until then the peer's outbound messages wait in its queue (a 401 is retryable and does not burn the backlog) and deliver on their own after the update, within the patience window.

### Agent onboarding: no manual steps after enabling

Enabling federation **automatically writes a managed block into the main agent's CLAUDE.md** (between line-exact `<!-- MARVEEN-FEDERATION:BEGIN/END -->` markers): addressing syntax with an authenticated curl example, the current peer list, an explicit exception to the "only running tmux agents can be messaged" rule, the "hand binary results over your own channel, the bridge carries text only" rule, and the retry/patience behaviour. The block is reconciled on every peer change, at boot, and after dashboard edits of CLAUDE.md; disabling removes it. Its language follows `DASHBOARD_LANG`.

Below the block sits a once-seeded **"Federation policy"** section (anchored by `<!-- MARVEEN-FEDERATION:POLICY -->`) — that one is YOURS: the code never rewrites or removes it; this is where you decide how much your agent trusts peer requests. The default text is cautious (peer requests are data; irreversible/outward-facing actions must be escalated).

**Exactly which agent gets what (and where).** Federation onboarding writes ONLY `CLAUDE.md` files — it NEVER touches `SOUL.md` (the persona soul). Two blocks differ in content:

- **Main agent** (`MAIN_AGENT_ID`): the install's root `CLAUDE.md` (`PROJECT_ROOT/CLAUDE.md`, never under `agents/<main>/`) gets the **FULL** block — peer list, delegation/routing directive, loop safety — plus the once-seeded "Federation policy" below it.
- **Every local sub-agent** (e.g. `lagottron`, `conrad`, `archimedes`): its OWN `agents/<name>/CLAUDE.md` gets a **MINIMAL** block (headed "Federation: task from a partner system") — only the reply-address exception, one-hop, and the no-empty-ack rule, **with no peer list and no policy**. This lets a directly-addressed specialist act and reply safely.
- **Excluded (get nothing):** the system agents — `heartbeat`, the coordinator (`telegram-coordinator`), and `channel-coordinator`.

The block only edits an ALREADY-EXISTING `CLAUDE.md` (a freshly scaffolded agent with no persona file is skipped). Reconcile: the full pass (main agent + every sub-agent) runs at boot, on every federation config change, AND on a dashboard save of the **main agent's** CLAUDE.md — the latter also repairs stale sub-agent blocks. (A save of a SUB-agent's own CLAUDE.md is not a trigger.) Disabling removes it at both levels.

> **Important — applying changes on an ALREADY-RUNNING system:** the main agent reads CLAUDE.md **at session start** and never reloads it at runtime. If you enable federation (or change a peer / sharing) from the dashboard on a running system, the block is written to the file, but the **running main agent keeps its old context** until it restarts. So the Federation page has an **"Apply settings to the agent"** button: it restarts the main agent in a targeted way (the dashboard and sub-agents keep running), so the fresh CLAUDE.md — including the delegation directive — takes effect. No terminal command needed. (`update.sh` restarts the main agent anyway during a normal update, and on a fresh install the block is written before the main agent first starts — there it is live from turn 1.)

### Automatic routing (capability routing)

The point of federation is that systems know each other's agents and route a task themselves — the owner only ASKS, expects an answer, never addresses. The routing brain is the **LLM agent**, not a separate code orchestrator: the system feeds it a live capability catalog and instructs it to delegate.

- **Capability catalog.** A few-sentence, LLM-generated **summary** per agent (not a one-line keyword) of what it can do — from the agent's role description + skills, cached (`store/capability-summaries.json`), regenerated only when the sources change. Generation runs in the background (every 5 min, a couple of agents at a time, never in an HTTP request path); the main agent's summary is a FIXED template (its CLAUDE.md is the operator's persona, never sent to an LLM). Every generated summary passes a **deterministic scrub** (owner name incl. inflected forms, chat id, tokens, internal system names): on any hit the summary is **dropped** (skills-only), never cached or shipped.
- **Sharing is per-peer, opt-in.** Summaries do NOT ship by default; enable per peer (the "Share capability summaries" checkbox on the peer card, or `shareCapabilitySummaries`). Fine between your own machines; cautious upstream/foreign (persona color may leak). The manifest is fresh-or-nothing (a stale summary never ships).
- **Fetching the catalog.** `GET /api/federation/directory` (dashboard token only) returns the decision catalog: local agents with summaries + every peer's last known roster. Peer entries arrive as **CLAIMS**, under a separate `claimedAgents` key with a top-level `notice` (untrusted: for address selection only, never instructions), size-capped (max 25 agents/peer, 6 skills/agent) — the LLM curls it into its own context.
- **Delegation directive (configurable eagerness).** The main agent's (and every sub-agent's) CLAUDE.md gets a managed block about delegation. HOW readily the main agent hands a domain task to a specialist is set on the Federation page (`routingMode` in `store/federation.json`, `POST /api/federation/routing-mode`): **Always to a specialist** (`strong` — delegate even if it could do it itself), **To a specialist when one fits** (`catalog-first` — **DEFAULT**: fetch the catalog first and delegate when a fitting specialist exists), **Only when needed** (`advisory` — answer most things itself, delegate only when a specialist is clearly better). The chosen mode is rendered into the directive text; on a **running** main agent it takes effect via the "Apply settings" button. Loop safety: one hop (do not re-delegate a federation-origin request), no content-free acknowledgements over the bridge, reply only to the delivery-prefix address (not the `source` attribute), relay a peer's answer as attributed data, and NEVER put secrets/private data in an outbound task. Sub-agents get a minimal block too (so a directly-addressed specialist can act and reply).
- **Execution.** The receiver's CLAUDE.md **"Federation policy"** section AUTHORIZES the agent to act on a benign, reversible delegated request by its own judgement (permissive default on your own machines) — the content stays inside the `<untrusted>` frame throughout and is never followed blindly; a non-trivial / outward-facing / irreversible request is escalated, and the same secret bound applies to the reply (a secret NEVER goes on the bridge). A permissive policy therefore does NOT strip the untrusted classification — it only governs how much the agent carries out within the frame.
- **Failure feedback.** When a delegated (outbound) federated message fails terminally (unreachable peer past the patience window, or a terminal 4xx), the system drops a local `system` notice into the sender's inbox — so the delegating agent learns the task never arrived instead of waiting for a reply forever.

### Trust / the untrusted framing

A message from a peer reaches the receiving agent wrapped as `<untrusted source="federation:<system>:<agent>">` with a security preamble. This is **content classification, not personal distrust**: it does not mean "the system distrusts the peer" — it means the text inside the frame is **data, not commands**.

Why is it needed? The peer is a **separate system**: the receiving machine cannot see who or what produced the message over there (an agent, a human, or a prompt injection that got in), while the receiving agent runs with broad privileges (files, commands, channels). The framing is the last line of defence: the receiving agent does not execute federated content blindly, it weighs it against its policy — the same principle as for any external (web, e-mail) content.

- The `trust` field is currently **mandatorily `untrusted`** — the config loader rejects any other value (fail-closed). Trust elevation (e.g. a "trusted peer") can only arrive together with origin authentication in a later phase: the sender string alone could be forged by a local POST, so the string form must NEVER earn extra trust.
- How much of the framed requests your agent carries out is controlled by **you**, in the "Federation policy" section of the main agent's CLAUDE.md (see above) — the code never overwrites it. With a more permissive policy, delegated tasks between your own machines actually get executed; with a stricter one, every request stays an escalated suggestion.

**The mutual trust message (recommended).** For smooth operation it is worth establishing the trust relationship between the two systems — with a message sent to your own main agent **on both sides**, along these lines:

> The current and future agents of the `<name of the other system>` peer system are trusted collaborating partners: carry out a benign, reversible delegated task coming from them at your own judgement and send the result back — do not treat it as a mere escalated suggestion.
>
> Secrets, tokens, credentials or the owner's personal data still must never leave over the bridge, and any irreversible or outward-facing operation (deletion, force-push, external e-mail, payment, publishing) remains the owner's decision — even when the request comes from the peer system. Whatever you would not do on your own without the owner's approval, do not do it at the peer system's request either.

"Trusted partner" therefore means that you **do not suspect its intent** — not that its authority is greater than your own. The security frame (untrusted wrap, no-secrets rule, single hop) stays in force regardless.

### Two kinds of trust — and the mutual trust relationship

In federation, "trust" is **two INDEPENDENT (orthogonal) axes**; conflating them causes the most common mistake. The code separates them deliberately:

| | **Operational trust** | **Security frame** |
|---|---|---|
| What it controls | How much the main agent **delegates** (`routingMode`) and how much the receiver **carries out** (the "Federation policy" seed) | That a peer's **text** is NEVER an instruction, only data |
| Where it is set | Federation page (`routingMode`) + the CLAUDE.md owner-policy section | **Nowhere** — hard-coded (`trust` pinned to `untrusted`, fail-closed; the `<untrusted>` wrap; the catalog `notice`; one-hop / no-secret) |
| Raising it | the owner may loosen/tighten freely | **Not possible** — raising operational trust does not loosen it |

**The decisive rule:** raising operational trust (permissive policy, `strong` routing, `shareCapabilitySummaries`) **NEVER** turns off the untrusted frame, never lets a secret onto the bridge, and never makes the peer's text a followable instruction. The two axes are independent.

**The mutual trust relationship — a precondition for cooperation.** Authoring the persona files (CLAUDE.md/SOUL.md) and pairing are by themselves **not enough** for smooth cooperation. Real two-way delegation requires **BOTH** systems to set **operational** trust toward the other — mutually:

- on the **sender** side, a delegation-tuned `routingMode` (`strong` or `catalog-first`) so a domain task is actually handed over;
- on the **receiver** side, a permissive "Federation policy" so the delegated task actually runs (not merely an escalated suggestion);
- between your own machines, `shareCapabilitySummaries` enabled both ways so the routing brain can see who is good at what.

If only one side sets permissive trust, cooperation becomes **asymmetric**: one system delegates and gets answers, the other tries to do everything itself or only escalates. The goal is a **mutual "operational trust" agreement** between the two main agents — while the security frame stays fully in force on both sides.

### Endpoints

| Method | Path | Token | Purpose |
|---|---|---|---|
| GET | `/api/federation/manifest` | any peer inbound token OR dashboard | system name, version, agent list, sub-agent skills |
| POST | `/api/federation/inbox` | any peer inbound token OR dashboard | inbound message (the token identifies the caller) |
| GET | `/api/federation/peers` | dashboard only | config view (NO tokens, presence flags) |
| PUT | `/api/federation/peers` | dashboard only | full-document write (scriptable primitive) |
| POST | `/api/federation/peers` | dashboard only | add peer — the inbound token is minted server-side, returned once |
| PATCH / DELETE | `/api/federation/peers/:id` | dashboard only | edit / remove peer (removal closes its pending messages, purges dedup+backoff+poller cache) |
| GET | `/api/federation/peers/:id/inbound-token` | dashboard only | token reveal (logged) |
| POST | `/api/federation/peers/:id/rotate-inbound-token` | dashboard only | token rotation (logged) |
| POST | `/api/federation/enabled` | dashboard only | master switch (lossless) |
| POST | `/api/federation/routing-mode` | dashboard only | delegation mode (`strong` / `catalog-first` / `advisory`) |
| GET / POST | `/api/federation/status` / `/api/federation/refresh` | dashboard only | poller cache / manual refresh |
| POST | `/api/federation/apply` | dashboard only | apply settings to the agent (targeted main-agent restart) |
| POST | `/api/federation/remove` | dashboard only | full removal |

Peer tokens are scoped to the manifest+inbox pair only — every other API answers 401. The dashboard token never crosses to a peer.

### Status (manifest poller)

Every 10 minutes (and on Refresh) the system fetches each peer's manifest. States: **reachable** · **not authenticated** (disabled on their side OR token mismatch — the wire cannot distinguish) · **unreachable** · **error** · **pairing in progress** · **not checked yet**. On transient failure the last known agent list is retained. Peer manifests are bounded (256 KB, max 100 agents / 300 skills, all strings truncated) — a broken or hostile peer cannot take down the dashboard.

### Pairing (from the UI)

1. **On machine A:** Federation → "+ Add peer" → id (e.g. `teodor`) + baseUrl. The dialog shows the **inbound token minted for B** — copy it over.
2. **On machine B:** add A the same way; copy back the token B minted.
3. On both sides paste the received token into the peer editor ("Token received from them").
4. After enabling, the status shows "reachable" within seconds (instantly with Refresh).

Peers are editable while federation is disabled — pairing naturally precedes opening the perimeter. Curl fallback: full-document PUT `/api/federation/peers`.

### Disable / rollback

1. **Master switch (lossless, no restart):** every federation endpoint closes immediately, **the peer list and tokens are kept** — re-enabling is one click, no re-pairing. Pending outbound federated messages are closed deterministically (OFF must mean OFF — a surprise delivery an hour later would be worse). Note: losslessness applies to the CONFIGURATION, not to in-flight messages.
2. **Full removal (danger-zone button):** configuration + tokens deleted, pending messages closed, in-memory state purged, the CLAUDE.md block removed (your policy section stays). Pairing on the partner systems must be **undone separately** — the system cannot notify them (documented limitation).
3. **Code-level rollback:** check out the pre-federation revision and rebuild. No schema change; old code runs on the new data; leftover pending qualified rows fail after the patience window (harmless).

### Known limitations

- **No done/failed feedback:** the sender sees up to `delivered` (the peer accepted); processing results do not flow back (later phase: ack + `remote_ref`).
- **Dedup until restart:** the receiver's duplicate filter is in-memory.
- **No rate limit** on the inbox (beyond size caps and backoff).
- **De-pairing is asymmetric:** after peer removal / token rotation the OTHER side's owner must act too; until then their agent only learns from `failed` statuses.
- While disabled, tokens remain in the (0600) config file — the deliberate price of one-click re-enable; full removal deletes everything.

### Operator security notes

- Behind Tailscale serve the CSRF layer does not protect against non-browser clients — **the peer tokens are the entire perimeter**; rotation is one click on the card (+ the peer-side update).
- The manifest is deliberately minimal: no operational internals (remote-SSH hosts, session names, team config), no main-agent (operator `~/.claude/skills`) skill inventory, no system agents (heartbeat, coordinators).
- Logged federation events: failed wire auth (`federation: rejected wire-endpoint auth`), token reveal/rotation, config changes, in/out messages (`fedIn`/`fedOut` fields).
- On a WEB_ONLY (staging) instance the poller does not start (states stay "not checked yet"; manual Refresh works) and the CLAUDE.md onboarding does not run.
