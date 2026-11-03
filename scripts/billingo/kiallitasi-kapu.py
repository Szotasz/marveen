#!/usr/bin/env python3
"""Issuing gate for billingo-hatralek-orszem (BILLINGOORSZEMKAPU1013, 2026-10-13).

Reads the section-1 query result (the JSON that scripts/supabase-q.sh prints)
and sorts every open billing_errors row into exactly one of two lists:

  ELIGIBLE  -- the row is an OLD-PATH Billingo issuance failure after a Stripe
               payment: it has a stripe_payment_id AND its error_message starts
               with one of the prefixes the old Billingo issuers write. Only
               these rows may go on to section 1.5 (claim) and 2 (issue).
  REPORT    -- everything else. Reported, never issued.

Why an allowlist and not "has a payment id": the refund rows of the old path
(refund-storno, aiam stripe-webhook) DO carry a stripe_payment_id, and
billing_errors also collects non-invoice failures (Impulzo webhook, trial drip,
licence delivery, coupon). Issuing a 27% Billingo document on any of those is
irreversible at NAV. An unknown message class therefore falls to REPORT: the
gate fails closed.

The prefixes come from the writers on origin/main (2026-10-13):
  aiam  supabase/functions/stripe-webhook/index.ts  (booking issuance, Marveen issuance)
  mio   supabase/functions/_shared/invoice-issuance.ts (Marveen issuance, old webhook only)

Usage:
  scripts/supabase-q.sh <ref> "<section-1 SQL>" --output-format json > rows.json
  python3 kiallitasi-kapu.py rows.json            # human summary + JSON on the last line
  python3 kiallitasi-kapu.py rows.json --claim-sql  # + the 1.5 claim SQL, ELIGIBLE rows only
  python3 kiallitasi-kapu.py --self-test          # fixture proof, issues nothing
"""
import json
import re
import sys

OLD_ISSUANCE_PREFIXES = (
    'Marveen Billingo issuance failed (queued for retry):',
    'Failed to create/get Billingo partner',
    'Failed to create Billingo document:',
    'Billingo exception:',
    'Reused Billingo partner has empty taxcode',
)

# Old-path classes that are NOT for automatic issuance (the task already flags
# them in section 3, or the message itself demands a manual procedure).
MANUAL_PREFIXES = (
    'Malformed billing tax number',      # manual NAV lookup + billingo-nav-reissue
    'Orphan Marveen Payment Link',        # no billing data: section 3 FLAG
)

PAYMENT_ID_PREFIXES = ('pi_', 'cs_')  # cs_: rows keyed on the Checkout session (NULLCLAIM905)


def classify(row):
    """Return (verdict, reason). verdict is 'ELIGIBLE' or 'REPORT'."""
    msg = (row.get('error_message') or '').strip()
    pid = (row.get('stripe_payment_id') or '').strip()
    ctx = row.get('context') or {}
    if isinstance(ctx, str):
        try:
            ctx = json.loads(ctx)
        except ValueError:
            ctx = {}
    if not isinstance(ctx, dict):
        ctx = {}

    if 'impulzo' in msg.lower() or str(ctx.get('account', '')).lower() == 'impulzo' \
            or 'impulzo' in str(ctx.get('source', '')).lower():
        return 'REPORT', 'Impulzo-ut: Stripe szamlaz, Billingo-bizonylat tilos'
    if ctx.get('fn'):
        return 'REPORT', f"nem szamlazasi hiba (context.fn={ctx.get('fn')})"
    for p in MANUAL_PREFIXES:
        if msg.startswith(p):
            return 'REPORT', f'kezi eljaras kell ({p})'
    if not msg.startswith(OLD_ISSUANCE_PREFIXES):
        return 'REPORT', 'nem a regi Billingo-kiallitas hibaja (ismeretlen osztaly)'
    if not pid:
        return 'REPORT', 'nincs stripe_payment_id'
    if not pid.startswith(PAYMENT_ID_PREFIXES):
        return 'REPORT', f'a stripe_payment_id nem pi_/cs_ alaku ({pid[:12]})'
    return 'ELIGIBLE', 'regi Billingo-kiallitas hibaja, fizetes-azonositoval'


SAFE_ID = re.compile(r'^[0-9a-fA-F-]{8,64}$')
SAFE_PID = re.compile(r'^(pi|cs)_[A-Za-z0-9_]{4,200}$')


def claim_sql(eligible):
    """The section-1.5 claim, built ONLY for ELIGIBLE rows. The row is pinned on
    BOTH its id and its payment id, so a row that changed between the gate and
    the claim is not claimed. A value that does not look like an id is refused
    (nothing is interpolated blindly into SQL)."""
    out = []
    for e in eligible:
        rid, pid = str(e.get('id') or ''), str(e.get('stripe_payment_id') or '')
        if not SAFE_ID.match(rid) or not SAFE_PID.match(pid):
            raise ValueError(f'nem biztonsagos azonosito, claim NEM keszul: {rid!r} {pid!r}')
        out.append(
            "UPDATE billing_errors SET issuing_by='billingo-hatralek-orszem', issuing_started_at=NOW() "
            f"WHERE id='{rid}' AND stripe_payment_id='{pid}' AND resolved=false "
            "AND (issuing_started_at IS NULL OR issuing_started_at < NOW() - INTERVAL '30 minutes') "
            "RETURNING id;"
        )
    return out


def rows_from_text(text):
    i = text.find('{')
    if i < 0:
        raise ValueError('nincs JSON a bemenetben: NEM MERT')
    data = json.loads(text[i:])
    rows = data.get('rows') if isinstance(data, dict) else data
    if rows is None:
        raise ValueError('a JSON-ban nincs rows mezo: NEM MERT')
    return rows


def gate(rows):
    eligible, report = [], []
    for r in rows:
        verdict, reason = classify(r)
        item = {'id': r.get('id'), 'stripe_payment_id': r.get('stripe_payment_id'), 'reason': reason}
        (eligible if verdict == 'ELIGIBLE' else report).append(item)
    return {'eligible': eligible, 'report': report}


FIXTURE = [
    # the only shape that may be issued
    {'id': 'ok-booking', 'stripe_payment_id': 'pi_old1', 'error_message': 'Failed to create Billingo document: 422', 'context': {}},
    {'id': 'ok-marveen', 'stripe_payment_id': 'cs_old2', 'error_message': 'Marveen Billingo issuance failed (queued for retry): timeout', 'context': {'amount': 95250}},
    # old issuance class but no payment id
    {'id': 'no-pi', 'stripe_payment_id': None, 'error_message': 'Billingo exception: boom', 'context': {}},
    # refund rows of the OLD path carry a payment id -- still not an issuance gap
    {'id': 'refund-old', 'stripe_payment_id': 'pi_ref', 'error_message': 'Refund received for payment pi_ref but no created invoice found', 'context': {'charge_id': 'ch_1'}},
    {'id': 'storno-old', 'stripe_payment_id': 'pi_ref2', 'error_message': 'Stripe refund storno failed: x', 'context': {}},
    # foreign sources
    {'id': 'impulzo-refund', 'stripe_payment_id': None, 'error_message': 'Impulzo refund: 52.00 USD of 52.00 USD', 'context': {'event_id': 'evt_1'}},
    {'id': 'impulzo-marked', 'stripe_payment_id': 'pi_new', 'error_message': 'Failed to create Billingo document: x', 'context': {'account': 'impulzo'}},
    {'id': 'drip', 'stripe_payment_id': None, 'error_message': '[TRIAL-DRIP] DRIP_FROM_ADDRESS nincs beallitva', 'context': {'fn': 'trial-drip-worker'}},
    {'id': 'fn-with-pi', 'stripe_payment_id': 'pi_x', 'error_message': 'Billingo exception: y', 'context': {'fn': 'something'}},
    {'id': 'licence', 'stripe_payment_id': None, 'error_message': 'Inline license issue failed for session cs_1: x', 'context': {'session_id': 'cs_1'}},
    # manual old-path classes
    {'id': 'orphan', 'stripe_payment_id': 'pi_orph', 'error_message': 'Orphan Marveen Payment Link checkout - no billing_info, kézi számlát kell kiállítani', 'context': {}},
    {'id': 'malformed', 'stripe_payment_id': 'pi_mal', 'error_message': 'Malformed billing tax number "1" (expected 11-digit HU format', 'context': {}},
    # odd payment id
    {'id': 'odd-pi', 'stripe_payment_id': 'ch_123', 'error_message': 'Billingo exception: z', 'context': {}},
    # context as a JSON string (PostgREST/CLI may hand it over that way)
    {'id': 'ctx-string', 'stripe_payment_id': 'pi_s', 'error_message': 'Billingo exception: z', 'context': '{"fn": "trial-extension-notice"}'},
]
EXPECTED_ELIGIBLE = {'ok-booking', 'ok-marveen'}
# Each REPORT row must be stopped by ITS OWN rule, not by a neighbouring one:
# a check that is shadowed by another would otherwise be untested.
EXPECTED_REASON = {
    'no-pi': 'nincs stripe_payment_id',
    'refund-old': 'ismeretlen osztaly',
    'storno-old': 'ismeretlen osztaly',
    'impulzo-refund': 'Impulzo-ut',
    'impulzo-marked': 'Impulzo-ut',
    'drip': 'context.fn=trial-drip-worker',
    'fn-with-pi': 'context.fn=something',
    'licence': 'ismeretlen osztaly',
    'orphan': 'kezi eljaras kell (Orphan',
    'malformed': 'kezi eljaras kell (Malformed',
    'odd-pi': 'nem pi_/cs_ alaku',
    'ctx-string': 'context.fn=trial-extension-notice',
}


def self_test():
    out = gate(FIXTURE)
    got = {e['id'] for e in out['eligible']}
    reported = {r['id'] for r in out['report']}
    ok = got == EXPECTED_ELIGIBLE and reported == {r['id'] for r in FIXTURE} - EXPECTED_ELIGIBLE
    reasons = {r['id']: r['reason'] for r in out['report']}
    for rid, want in EXPECTED_REASON.items():
        if want not in reasons.get(rid, ''):
            ok = False
            print(f"REASON MISMATCH {rid}: want '{want}', got '{reasons.get(rid)}'")
    for r in FIXTURE:
        verdict = 'ELIGIBLE' if r['id'] in got else 'REPORT'
        print(f"{verdict:8} {r['id']} {reasons.get(r['id'], '')}")
    # the claim exists only for ELIGIBLE rows (ids made UUID-shaped for this check)
    uuid_rows = [dict(r, id=f'00000000-0000-0000-0000-{i:012d}') for i, r in enumerate(FIXTURE)]
    uuid_out = gate(uuid_rows)
    sqls = claim_sql(uuid_out['eligible'])
    want_ids = {e['id'] for e in uuid_out['eligible']}
    if len(sqls) != len(want_ids) or any(not any(f"id='{w}'" in q for q in sqls) for w in want_ids):
        ok = False
        print('CLAIM MISMATCH: a claim nem pontosan az ELIGIBLE sorokra keszult')
    if any("AND stripe_payment_id='" not in q for q in sqls):
        ok = False
        print('CLAIM NOT PINNED ON THE PAYMENT ID')
    for r in uuid_out['report']:
        if any(f"id='{r['id']}'" in q for q in sqls):
            ok = False
            print(f"CLAIM FOR REPORT ROW {r['id']}")
    try:
        claim_sql([{'id': "x' OR '1'='1", 'stripe_payment_id': 'pi_abcd'}])
        ok = False
        print('UNSAFE ID ACCEPTED')
    except ValueError:
        pass
    print('SELF-TEST', 'OK' if ok else f'FAIL: eligible={sorted(got)}')
    return 0 if ok else 1


def main(argv):
    if argv[1:] == ['--self-test']:
        return self_test()
    want_claim = '--claim-sql' in argv
    args = [a for a in argv[1:] if a != '--claim-sql']
    if len(args) != 1:
        print(__doc__)
        return 2
    text = sys.stdin.read() if args[0] == '-' else open(args[0], encoding='utf-8').read()
    try:
        rows = rows_from_text(text)
    except ValueError as e:
        print(str(e))
        return 3
    out = gate(rows)
    print(f"nyitott: {len(rows)} | kiallithato (ELIGIBLE): {len(out['eligible'])} | csak jelentes (REPORT): {len(out['report'])}")
    for e in out['eligible']:
        print(f"  ELIGIBLE {e['id']} {e['stripe_payment_id']}")
    for r in out['report']:
        print(f"  REPORT   {r['id']} -- {r['reason']}")
    print(json.dumps(out, ensure_ascii=False))
    if want_claim:
        try:
            for q in claim_sql(out['eligible']):
                print('CLAIM-SQL ' + q)
        except ValueError as e:
            print(str(e))
            return 4
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
