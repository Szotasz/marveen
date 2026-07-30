// Block B wiring: the profile layer must be ADDITIVE over the existing model
// selection, not a replacement for it (marveen acceptance criterion,
// 2026-07-29). That additivity is also what makes it upstream-committable.
//
// Exercised through the real agent-config fs layer, not the pure resolver, so
// this covers the part the unit tests cannot: that readAgentModel still answers
// what it always answered.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readAgentModel,
  resolveAgentModelDetailed,
  invalidateModelProfileMapCache,
  AGENTS_BASE_DIR,
} from '../web/agent-config.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_ROOT = join(SRC, '..');
const MAP_PATH = join(PROJECT_ROOT, 'store', 'model-profile-map.json');

const MAP = {
  version: 'wiring-test-1',
  profiles: {
    premium_reasoning: 'claude-opus-5',
    build_strong: 'claude-sonnet-5',
    analysis_efficient: 'deepseek-v4-pro',
    routine_lowcost: 'deepseek-v4-pro',
  },
};

// Fixtures mirror the two real canary agents' post-reassignment configs.
const FIXTURES: Record<string, Record<string, unknown>> = {
  'mp-legacy-explicit': { model: 'claude-sonnet-5' },
  'mp-canary-build': { model: 'claude-sonnet-5', modelProfile: 'build_strong' },
  'mp-canary-research': { model: 'deepseek-v4-pro', modelProfile: 'analysis_efficient' },
  'mp-profile-only': { modelProfile: 'analysis_efficient' },
  'mp-bad-profile': { modelProfile: 'turbo' },
};

let createdStore = false;

beforeAll(() => {
  createdStore = !existsSync(join(PROJECT_ROOT, 'store'));
  mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true });
  writeFileSync(MAP_PATH, JSON.stringify(MAP, null, 2));
  invalidateModelProfileMapCache();
  for (const [name, cfg] of Object.entries(FIXTURES)) {
    mkdirSync(join(AGENTS_BASE_DIR, name), { recursive: true });
    writeFileSync(join(AGENTS_BASE_DIR, name, 'agent-config.json'), JSON.stringify(cfg));
  }
});

afterAll(() => {
  for (const name of Object.keys(FIXTURES)) rmSync(join(AGENTS_BASE_DIR, name), { recursive: true, force: true });
  rmSync(MAP_PATH, { force: true });
  if (createdStore) rmSync(join(PROJECT_ROOT, 'store'), { recursive: true, force: true });
  invalidateModelProfileMapCache();
});

describe('additive over the existing selector', () => {
  it('an agent with only a legacy explicit model resolves exactly as before', () => {
    expect(readAgentModel('mp-legacy-explicit')).toBe('claude-sonnet-5');
    expect(resolveAgentModelDetailed('mp-legacy-explicit').source).toBe('explicit_model');
  });

  it('ADDING modelProfile to a canary agent does not change its resolved model', () => {
    // This is the Block B acceptance criterion in one assertion: the two live
    // canary agents keep their explicit model AND gain a profile, and the
    // resolved-model diff is empty.
    expect(readAgentModel('mp-canary-build')).toBe('claude-sonnet-5');
    expect(readAgentModel('mp-canary-research')).toBe('deepseek-v4-pro');
    expect(resolveAgentModelDetailed('mp-canary-build').source).toBe('explicit_model');
    expect(resolveAgentModelDetailed('mp-canary-research').source).toBe('explicit_model');
  });

  it('an agent with ONLY a profile resolves through the map', () => {
    const r = resolveAgentModelDetailed('mp-profile-only');
    expect(r.model).toBe('deepseek-v4-pro');
    expect(r.source).toBe('model_profile');
  });

  it('an unknown profile id surfaces an error instead of silently switching models', () => {
    const r = resolveAgentModelDetailed('mp-bad-profile');
    expect(r.source).toBe('default');
    expect(r.error).toContain('unknown_model_profile');
  });

  it('an agent with no config at all still gets the install default', () => {
    expect(typeof readAgentModel('mp-does-not-exist')).toBe('string');
    expect(readAgentModel('mp-does-not-exist').length).toBeGreaterThan(0);
  });
});

describe('the existing model selector is untouched', () => {
  // marveen: "Do NOT rip out or replace the existing opus5/sonnet5 selection."
  // These assert the pre-existing machinery is still whole, so a later
  // refactor cannot quietly turn the additive layer into a replacement.
  it('config-registry still owns the distribution default', () => {
    const registry = readFileSync(join(SRC, 'config-registry.ts'), 'utf-8');
    expect(registry).toContain('DISTRIBUTION_DEFAULT_AGENT_MODEL');
    expect(registry).not.toContain('modelProfile');
  });

  it('model-suggest still exists and knows nothing about profiles', () => {
    const suggest = readFileSync(join(SRC, 'web', 'model-suggest.ts'), 'utf-8');
    expect(suggest.length).toBeGreaterThan(0);
    expect(suggest).not.toContain('modelProfile');
  });

  it('the legacy alias table is still applied and still owns the short names', () => {
    const cfg = readFileSync(join(SRC, 'web', 'agent-config.ts'), 'utf-8');
    expect(cfg).toContain('export const MODEL_ALIASES');
    expect(cfg).toContain("'sonnet': 'claude-sonnet-5'");
    // The resolver receives resolveModelId as its alias hook rather than
    // reimplementing aliasing, so there is exactly one alias table.
    expect(cfg).toContain('resolveAgentModelFromConfig(config, readModelProfileMap(), DEFAULT_MODEL, resolveModelId)');
  });

  it('the profile module does not import the existing selector', () => {
    const profiles = readFileSync(join(SRC, 'model-profiles.ts'), 'utf-8');
    expect(profiles).not.toContain('config-registry');
    expect(profiles).not.toContain('model-suggest');
    // Pure: no fs/env, so it is portable as an upstream contribution.
    expect(profiles).not.toContain("from 'node:fs'");
    expect(profiles).not.toContain('process.env');
  });
});
