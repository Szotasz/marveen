#!/usr/bin/env python3
"""Retired: /usage now lives in marveen-commands.py (ELSOKOR922 spec D-4).

Kept as a silent no-op on purpose. A main session started before the update
still carries the old UserPromptSubmit registration in memory; if this file
vanished, python3 would exit 2 ("can't open file") and a non-zero
UserPromptSubmit hook BLOCKS every prompt -- the main agent would go deaf
until restarted (the 2026-07-11 stale-hook incident, hook-registration-guard.ts).
Safe to delete once no install can still run a pre-D-4 session.
"""
import sys

sys.exit(0)
