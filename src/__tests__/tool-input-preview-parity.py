#!/usr/bin/env python3
"""APRO920 (b): loads the shipped _input_summary/_redact straight out of
scripts/hooks/tool-log-capture.py (not a re-typed copy) and runs it over the
shared fixture, so the TS parity test compares against the ACTUAL source."""
import importlib.util
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOK_PATH = os.path.join(ROOT, 'scripts', 'hooks', 'tool-log-capture.py')
FIXTURE_PATH = os.environ.get('TOOL_INPUT_PREVIEW_FIXTURE') or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'tool-input-preview.json'
)

spec = importlib.util.spec_from_file_location('tool_log_capture', HOOK_PATH)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

cases = json.load(open(FIXTURE_PATH))
out = [mod._input_summary(c['input'], c['toolName']) for c in cases]
print(json.dumps(out))
