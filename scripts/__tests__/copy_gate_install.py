"""Test helper (not a suite: the runner only picks *.test.py / *.test.sh).

ENVRELAXGATE1104: outgoing-copy-gate.py reads its name rules only from its OWN
install, <install>/store/outgoing-copy-gate-rules.json, and writes its log next
to that file; no environment variable points it elsewhere. A test that used to
hand the hook a rules path through the environment runs it from a tmp install
instead: <rules_path>.inst/ with scripts/ linked to this repo's (the hook takes
its root from abspath, not realpath) and store/outgoing-copy-gate-rules.json
LINKED to the test's rules path, so a later write to that path, a missing file
or a corrupt one reach the hook exactly as before. The same rules path always
gives the same install, so the gate log accumulates as it did next to the file.
"""
import os

_REPO_SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def copy_gate_install(rules_path):
    """(hook path, store dir) of the tmp install that reads `rules_path`."""
    root = os.path.abspath(rules_path) + ".inst"
    store = os.path.join(root, "store")
    os.makedirs(store, exist_ok=True)
    link = os.path.join(root, "scripts")
    if not os.path.lexists(link):
        os.symlink(_REPO_SCRIPTS, link)
    rules = os.path.join(store, "outgoing-copy-gate-rules.json")
    if not os.path.lexists(rules):
        os.symlink(os.path.abspath(rules_path), rules)
    return os.path.join(link, "hooks", "outgoing-copy-gate.py"), store


def bare_install(parent):
    """(hook path, store dir) of a tmp install under `parent` with NO rules file."""
    root = os.path.join(os.path.abspath(parent), "bare.inst")
    store = os.path.join(root, "store")
    os.makedirs(store, exist_ok=True)
    link = os.path.join(root, "scripts")
    if not os.path.lexists(link):
        os.symlink(_REPO_SCRIPTS, link)
    return os.path.join(link, "hooks", "outgoing-copy-gate.py"), store
