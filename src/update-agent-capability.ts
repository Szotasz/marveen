import { readFileSync } from 'node:fs'
import { platform } from 'node:os'

// Can a Claude Code agent be spawned on THIS host? The Claude Code binary is a
// Bun standalone that requires AVX; on a CPU without it the agent segfaults /
// SIGILLs on launch (see the AVX-less QEMU-VPS incident). The post-rollback
// fixer (PR-D) must NOT be offered on such a host -- there we surface a
// "needs a human" note instead of spawning an agent that cannot start.
//
// The core is a pure function over /proc/cpuinfo text so it is unit-testable.

// Does this x86 cpuinfo advertise the AVX flag? The flags line looks like:
//   flags : fpu vme de ... avx avx2 ...
export function cpuinfoHasAvx(cpuinfo: string): boolean {
  return /^flags\s*:.*\bavx\b/m.test(cpuinfo)
}

// Is this an x86 cpuinfo at all? x86 uses "flags :"; ARM uses "Features :".
function cpuinfoIsX86(cpuinfo: string): boolean {
  return /^flags\s*:/m.test(cpuinfo)
}

// Decide from platform + a cpuinfo reader whether a Claude agent can run.
//   - Linux x86: require the AVX flag.
//   - Linux ARM (no "flags :" line): the arm64 binary has no AVX concept -> ok.
//   - Linux with an unreadable/empty cpuinfo: do NOT block on an uncertain probe.
//   - macOS: Apple Silicon runs the arm64 binary; Intel Macs that run Claude
//     have AVX. Treat as runnable.
//   - Anything else: runnable (never block on an unknown platform).
export function claudeAgentRunnable(
  plat: string = platform(),
  readCpuinfo: () => string = () => {
    try { return readFileSync('/proc/cpuinfo', 'utf-8') } catch { return '' }
  },
): boolean {
  if (plat !== 'linux') return true
  const info = readCpuinfo()
  if (!info) return true
  if (cpuinfoIsX86(info) && !cpuinfoHasAvx(info)) return false
  return true
}
