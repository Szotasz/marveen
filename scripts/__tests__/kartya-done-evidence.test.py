#!/usr/bin/env python3
"""Test that a comment-mode move to done also fills kanban_cards.done_evidence (#566).

The /move route lets an agent close a card to done only with evidence. The card script
moves cards straight in the DB, and in comment mode the comment is mandatory, so the
comment IS the evidence: it lands in done_evidence in the same UPDATE. On an older DB
without the column the move must still work unchanged.

Run:
    python3 scripts/__tests__/kartya-done-evidence.test.py
Exit 0 = all pass; non-zero = a failure (message on stderr).
"""
import importlib.util, os, sqlite3, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('mezo', os.path.join(HERE, 'kartya-mezomozgatas.test.py'))
M = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(M)


def evidence(card_id):
    db = sqlite3.connect(M.DB_PATH)
    r = db.execute('SELECT done_evidence FROM kanban_cards WHERE id=?', (card_id,)).fetchone()
    db.close()
    return r[0] if r else None


def main():
    fd, M.DB_PATH = tempfile.mkstemp(suffix='.db', prefix='kartya-ev-')
    os.close(fd); os.remove(M.DB_PATH)

    # A) OLD DB, no done_evidence column: the move to done still works.
    M.fresh_db(M.DB_PATH)
    M.seed('EVREGI566', 'in_progress')
    p = M.comment('EVREGI566', 'Kartya EVREGI566: kesz, a teszt zold.', ('--status', 'done'))
    M.check('A regi DB-n a done-mozgatas lefut', p.returncode == 0, p.stdout + p.stderr)
    M.check('A a statusz done', M.card('EVREGI566')[0] == 'done', str(M.card('EVREGI566')))

    # B) NEW DB: the comment text becomes done_evidence.
    db = sqlite3.connect(M.DB_PATH)
    db.execute('ALTER TABLE kanban_cards ADD COLUMN done_evidence TEXT')
    db.commit(); db.close()
    M.seed('EVUJ566', 'in_progress')
    p = M.comment('EVUJ566', 'Kartya EVUJ566: vitest 10 zold, tsc tiszta.', ('--status', 'done'))
    M.check('B lefutott', p.returncode == 0, p.stdout + p.stderr)
    M.check('B a statusz done', M.card('EVUJ566')[0] == 'done', str(M.card('EVUJ566')))
    ev = evidence('EVUJ566') or ''
    M.check('B a done_evidence a komment szovege', 'vitest 10 zold' in ev, repr(ev))

    # C) A move to anything but done leaves done_evidence alone.
    M.seed('EVWAIT566', 'in_progress')
    p = M.comment('EVWAIT566', 'Kartya EVWAIT566: a gazdara var.', ('--status', 'waiting'))
    M.check('C lefutott', p.returncode == 0, p.stdout + p.stderr)
    M.check('C waiting-nel a done_evidence ures marad', evidence('EVWAIT566') is None,
            repr(evidence('EVWAIT566')))

    os.remove(M.DB_PATH)
    if M.FAILS:
        sys.stderr.write('\nBUKOTT: ' + ', '.join(M.FAILS) + '\n')
        return 1
    print('\nminden teszt atment')
    return 0


if __name__ == '__main__':
    sys.exit(main())
