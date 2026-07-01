import { describe, it, expect } from 'vitest'
import { modelContextWindowK, isClaudeModel } from '../web/agent-config.js'

describe('isClaudeModel', () => {
  it('recognises Claude-routed models (native auto-compaction, watcher skips them)', () => {
    expect(isClaudeModel('claude-opus-4-8[1m]')).toBe(true)
    expect(isClaudeModel('claude-sonnet-4-6')).toBe(true)
  })
  it('is false for non-Claude routed models (watcher-managed)', () => {
    expect(isClaudeModel('MiniMax-M3')).toBe(false)
    expect(isClaudeModel('deepseek-chat')).toBe(false)
    expect(isClaudeModel('litellm/minimax-m3')).toBe(false)
    expect(isClaudeModel('qwen3:8b')).toBe(false)
  })
})

describe('modelContextWindowK', () => {
  it('maps known models to their usable window (k tokens), case-insensitive', () => {
    expect(modelContextWindowK('MiniMax-M3')).toBe(1000)
    expect(modelContextWindowK('minimax-m2.5')).toBe(200)
    expect(modelContextWindowK('deepseek-chat')).toBe(120)
    expect(modelContextWindowK('claude-opus-4-8[1m]')).toBe(1000)
    expect(modelContextWindowK('claude-haiku-4-5')).toBe(200)
  })
  it('peeks at the litellm/<alias> backend', () => {
    expect(modelContextWindowK('litellm/minimax-m3')).toBe(1000)
    expect(modelContextWindowK('litellm/minimax-m2')).toBe(200)
  })
  it('falls back conservatively for unknown models (compact early, never wedge)', () => {
    expect(modelContextWindowK('some-unknown-local-model:latest')).toBe(180)
  })
})
