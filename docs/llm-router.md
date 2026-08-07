# Eco-mode local LLM router (P1)

A small service in front of the two GPU hosts. Phase P1 of
`docs/eco-mode-local-router-plan.md`: static routing table, health gate,
OpenAI-compatible endpoint, **no queue**.

The code lives with the rest of the fleet (`src/llm-router/`) so it is built,
type-checked and tested by the same pipeline; the unit file sits with the other
ones in `scripts/systemd/`.

## What it does

| Endpoint | Purpose |
|---|---|
| `POST /v1/chat/completions` | OpenAI-shaped call: the caller names a task class, the router picks machine and model |
| `POST /api/chat` | the same routing for callers that already speak ollama |
| `GET /health` | which machines answered, what is busy, which classes exist |

The task class comes from the `x-task-class` header or a `task_class` body
field. An unknown class is treated as `general`.

## The rules it enforces, and why they live here

These are measurements from #133, not preferences — and they are in the router
rather than in a prompt convention because a convention is something the caller
can forget.

- **laguna** is always called over `/api/chat` with `think: true`.
  `/api/generate` was measured degenerating, and structured work needs thinking.
- **gemma4** always gets `think: false`. In its default thinking mode it
  returns an *empty* answer under ollama, which reads as a broken model rather
  than a broken call.
- **StrikeX** never receives a prompt over ~8k tokens. Its prompt evaluation
  runs at 52-570 tok/s, so a long prompt costs one to two minutes before the
  first token appears.
- **Long-context work** runs on air903max or nowhere. When that machine is away
  the honest local answer is a refusal, not a two-minute wait.
- **Agent loops and tool use** are refused outright (`501`). Not measured, and a
  guess presented as a capability is worse than a plain no.

A caller cannot switch any of these off. That is the point of the router.

## No queue, on purpose

One request per machine is the VRAM reality. A second concurrent request for
the same machine is refused with `503` and a `Retry-After` rather than queued:
queueing hides contention behind latency, and a caller can do something better
with a refusal (retry, cloud, later) than with a request that silently takes
two minutes.

## Deploying

**Not deployed yet.** It needs a host that reaches both GPU machines and has
Node 20+; the plan names peci01. That host was not reachable from this box
(`ssh` publickey denied), so the runtime there is unverified — worth one check
before install.

```bash
npm run build                      # tsc, produces dist/
sudo mkdir -p /opt/llm-router && sudo cp -r dist/llm-router/* /opt/llm-router/
sudo cp scripts/systemd/llm-router.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now llm-router
curl -s http://localhost:11500/health
```

## The acceptance test

`scripts/llm-router-battery.mjs` drives the six #133 benchmark tasks through
the router, by class, and checks each one reaches the machine and model the
table promises. It exits non-zero on a mismatch, so it can gate a deployment
rather than be read by eye.

```bash
node scripts/llm-router-battery.mjs --router http://<host>:11500
```

Run on 2026-08-07 from the nucbox against the live machines: **7/7 routed as
the table promises.**

| Task | Class | Served by | ms |
|---|---|---|---|
| hu_summary | summary | air903max / qwen3-coder:latest | 1294 |
| hu_qa | hungarian | air903max / gemma4:31b-magyar | 22102 |
| en_draft | general | air903max / qwen3-coder:latest | 16498 |
| json_tool | structured | air903max / qwen3-coder:latest (valid JSON) | 1063 |
| code | code | air903max / laguna-xs.2:fixed | 21616 |
| long_ctx | long-context | air903max / qwen3-coder:latest | 16236 |
| agent_loop | agent-loop | refused, `cloud-only` | 10 |

The latencies show the model thrash the plan warned about: a task that reuses
the loaded model answers in about a second, a task that forces a swap costs
16-22. That is the measurement behind leaving batching out of P1 rather than a
reason to add it blindly -- what to batch is a P3 question, with numbers.

The fallback and prompt-ceiling paths are covered by unit tests with a control
run rather than live: proving them live would mean taking a machine down, and
the control (removing the rule, watching exactly the covering tests fail) is
the stronger evidence anyway.

One honest observation from the live run, about the models rather than the
router: on `hungarian`, gemma answered the test question incorrectly (it
defined an abandoned cart as a *person*). Routing was right; whether Hungarian
user-facing text should go local at all is a question for the measurement
phase, not for this one.
