import { describe, expect, it } from 'vitest'
import { cpuinfoHasAvx, claudeAgentRunnable } from '../update-agent-capability.js'

const X86_WITH_AVX = `processor\t: 0
vendor_id\t: GenuineIntel
flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep avx avx2 fma
`
const X86_NO_AVX = `processor\t: 0
vendor_id\t: GenuineIntel
model name\t: QEMU Virtual CPU version 2.5+
flags\t\t: fpu de pse tsc msr pae mce cx8 apic sep mtrr sse sse2
`
const ARM = `processor\t: 0
BogoMIPS\t: 48.00
Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32
CPU implementer\t: 0x41
`

describe('cpuinfoHasAvx', () => {
  it('detects avx when present in the flags line', () => {
    expect(cpuinfoHasAvx(X86_WITH_AVX)).toBe(true)
  })
  it('returns false when the flags line has no avx', () => {
    expect(cpuinfoHasAvx(X86_NO_AVX)).toBe(false)
  })
  it('matches only the standalone avx token, not a substring of another flag', () => {
    // Real cpuinfo lists the standalone "avx" flag separately from avx512*.
    expect(cpuinfoHasAvx('flags : fpu avx avx512f')).toBe(true)
    // avx512* WITHOUT a standalone avx token must not match (word-boundary).
    expect(cpuinfoHasAvx('flags : fpu avx512f')).toBe(false)
    expect(cpuinfoHasAvx('flags : fpu xavxy')).toBe(false)
  })
})

describe('claudeAgentRunnable', () => {
  it('linux x86 WITH avx -> runnable', () => {
    expect(claudeAgentRunnable('linux', () => X86_WITH_AVX)).toBe(true)
  })
  it('linux x86 WITHOUT avx -> NOT runnable (the AVX-less VPS case)', () => {
    expect(claudeAgentRunnable('linux', () => X86_NO_AVX)).toBe(false)
  })
  it('linux ARM (Features:, no flags line) -> runnable', () => {
    expect(claudeAgentRunnable('linux', () => ARM)).toBe(true)
  })
  it('linux with unreadable cpuinfo -> runnable (no block on uncertain probe)', () => {
    expect(claudeAgentRunnable('linux', () => '')).toBe(true)
  })
  it('macOS -> runnable regardless of cpuinfo', () => {
    expect(claudeAgentRunnable('darwin', () => X86_NO_AVX)).toBe(true)
  })
})
