#!/usr/bin/env node
// The #133 benchmark battery, driven THROUGH the router.
//
// The acceptance test for phase P1 (docs/eco-mode-local-router-plan.md): the
// same six tasks the models were measured on, sent by task class, checking
// that each one reaches the machine and model the table promises.
//
// It asserts the ROUTING, not the answers. Model quality was the subject of
// #133 and is measured directly against the hosts; what can only be checked
// here is whether a caller who names a class actually gets the machine that
// class was measured on -- and, for the structured task, that the router's
// forced options did not break the one output shape a caller depends on.
//
//   node scripts/llm-router-battery.mjs [--router http://127.0.0.1:11500]
//
// Exits non-zero if any task lands somewhere the table did not promise, so it
// can gate a deployment rather than be read by eye.

const routerArg = process.argv.indexOf('--router')
const ROUTER = routerArg > -1 ? process.argv[routerArg + 1] : process.env.ROUTER_URL || 'http://127.0.0.1:11500'

const HU_TEXT =
  'A vállalat tavaly ősszel döntött úgy, hogy a belső levelezését és a dokumentumkezelését ' +
  'felhőszolgáltatásba költözteti. A migráció első szakasza novemberben zökkenőmentesen lezajlott, ' +
  'a második szakasz azonban két hónapos csúszást szenvedett, mert a régi rendszerben tárolt fájlok ' +
  'jogosultsági beállításait nem lehetett automatikusan átvinni. A tanulság a zárójelentés szerint ' +
  'az volt, hogy a jogosultsági audit a migráció előtt kell hogy megtörténjen, nem közben.'

const CODE_SNIPPET = `
async function fetchAllPages(url) {
  const results = [];
  let page = 1;
  while (true) {
    const res = await fetch(\`\${url}?page=\${page}\`);
    const data = await res.json();
    if (data.items.length === 0) break;
    results.push(data.items);
    page++;
  }
  return results.flat();
}
`

// The six #133 tasks, each labelled with the class it belongs to and the
// machine that class was measured on. The expectation is the routing table's
// promise, written out so a mismatch is a failure rather than a surprise.
const BATTERY = [
  {
    key: 'hu_summary',
    taskClass: 'summary',
    expect: { host: 'air903max', model: 'qwen3-coder:latest' },
    prompt: `Foglald össze magyarul, legfeljebb három mondatban:\n\n${HU_TEXT}`,
  },
  {
    key: 'hu_qa',
    taskClass: 'hungarian',
    expect: { host: 'air903max', model: 'gemma4:31b-magyar' },
    prompt:
      'Válaszolj magyarul, tömören. Egy kolléga kérdezi: lejárt a jelszava a céges laptopon, ' +
      'home office-ban van VPN nélkül, telefonról már beállította az újat. Miért nem tud belépni?',
  },
  {
    key: 'en_draft',
    taskClass: 'general',
    expect: { host: 'air903max', model: 'qwen3-coder:latest' },
    prompt:
      'Write a short, professional support email (max 120 words) to a customer whose CSV export ' +
      'came out empty because her date filter excluded every row.',
  },
  {
    key: 'json_tool',
    taskClass: 'structured',
    expect: { host: 'air903max', model: 'qwen3-coder:latest' },
    validate: 'json',
    prompt:
      'Extract the following order into JSON. Respond with ONLY valid JSON, no markdown fences, ' +
      'matching: {"customer": string, "items": [{"sku": string, "qty": number, "unit_price_huf": number}], ' +
      '"shipping": "standard"|"express", "total_huf": number}\n\n' +
      'Order: Kovács Béla rendelt 2 db ABC-123 tételt darabonként 4990 Ft-ért és 1 db XYZ-77-et ' +
      '12990 Ft-ért, expressz szállítással (a szállítás ingyenes).',
  },
  {
    key: 'code',
    taskClass: 'code',
    expect: { host: 'air903max', model: 'laguna-xs.2:fixed' },
    prompt: `What bug or risk do you see in this JavaScript function? Answer in at most 5 sentences.\n${CODE_SNIPPET}`,
  },
  {
    key: 'long_ctx',
    taskClass: 'long-context',
    expect: { host: 'air903max', model: 'qwen3-coder:latest' },
    // Long enough to be the long-context class, short enough not to spend two
    // minutes proving a routing rule.
    prompt: `${HU_TEXT}\n\n`.repeat(12) + 'Egyetlen mondatban: mi volt a zárójelentés tanulsága?',
  },
  {
    key: 'agent_loop',
    taskClass: 'agent-loop',
    expectRefusal: 'cloud-only',
    prompt: 'Plan and execute a three step task using tools.',
  },
]

/** Strip a fenced block if the model wrapped its JSON anyway. */
const unfence = (text) => text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()

async function run() {
  const rows = []
  let failures = 0

  for (const task of BATTERY) {
    const started = Date.now()
    let res
    try {
      res = await fetch(`${ROUTER}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-task-class': task.taskClass },
        body: JSON.stringify({ messages: [{ role: 'user', content: task.prompt }] }),
      })
    } catch (err) {
      rows.push({ key: task.key, verdict: 'ROUTER UNREACHABLE', detail: err.message })
      failures++
      continue
    }

    const body = await res.json().catch(() => ({}))
    const ms = Date.now() - started

    if (task.expectRefusal) {
      const ok = body?.error?.code === task.expectRefusal
      if (!ok) failures++
      rows.push({
        key: task.key,
        class: task.taskClass,
        verdict: ok ? 'refused as promised' : `EXPECTED refusal ${task.expectRefusal}, got ${res.status}`,
        detail: body?.error?.code ?? '',
        ms,
      })
      continue
    }

    const host = body?.x_router_host
    const model = body?.model
    const routed = host === task.expect.host && model === task.expect.model
    if (!routed) failures++

    let validity = ''
    if (task.validate === 'json') {
      // Not a quality score -- a check that the router's forced options did not
      // break the one output shape a structured caller depends on.
      try {
        JSON.parse(unfence(body?.choices?.[0]?.message?.content ?? ''))
        validity = 'valid JSON'
      } catch {
        validity = 'INVALID JSON'
      }
    }

    rows.push({
      key: task.key,
      class: task.taskClass,
      verdict: routed ? 'as promised' : `EXPECTED ${task.expect.host}/${task.expect.model}`,
      detail: `${host ?? '-'} / ${model ?? '-'}${validity ? ` | ${validity}` : ''}`,
      ms,
    })
  }

  const pad = (s, n) => String(s ?? '').padEnd(n)
  console.log(`router: ${ROUTER}`)
  console.log(pad('task', 12) + pad('class', 14) + pad('verdict', 26) + pad('served by', 40) + 'ms')
  for (const r of rows) {
    console.log(pad(r.key, 12) + pad(r.class, 14) + pad(r.verdict, 26) + pad(r.detail, 40) + (r.ms ?? ''))
  }

  // A count, not a mood: this is meant to gate a deployment.
  console.log(`\n${rows.length - failures}/${rows.length} routed as the table promises`)
  process.exit(failures === 0 ? 0 : 1)
}

run()
