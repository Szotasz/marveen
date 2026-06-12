import os from 'node:os'

// Pick the best LAN IPv4 address for reaching this host from another device on
// the same network (e.g. a phone scanning the mobile-login QR). The desktop
// usually opens the dashboard on localhost/127.0.0.1, so window.location.origin
// is useless for the QR -- the phone would hit its OWN localhost. The server
// resolves its real LAN IP here instead.
//
// Heuristics: skip loopback, VPN/tunnel (utun/tun/tap), and virtualization
// (docker/bridge/vmnet/awdl) interfaces; keep only private-range IPv4 (the
// address a phone on the same WiFi can route to); prefer the common physical
// interface names. Returns null when nothing qualifies, so the caller can tell
// the user to open the dashboard on the LAN IP directly rather than show a
// broken QR.

const SKIP_IFACE = /^(lo|utun|tun|tap|bridge|docker|vmnet|vnic|llw|awdl|gif|stf|ap\d)/i
const PREFERRED = ['en0', 'en1', 'eth0', 'eth1', 'wlan0', 'wlan1']

export function isPrivateIpv4(ip: string): boolean {
  return (
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  )
}

function rank(name: string): number {
  const i = PREFERRED.indexOf(name)
  return i === -1 ? 99 : i
}

export function pickLanIp(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string | null {
  const candidates: Array<{ name: string; addr: string }> = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs || SKIP_IFACE.test(name)) continue
    for (const a of addrs) {
      // Node 20 reports family as the string 'IPv4'; accept the numeric 4 too
      // for forward-compatibility.
      const isV4 = a.family === 'IPv4' || (a.family as unknown) === 4
      if (isV4 && !a.internal && isPrivateIpv4(a.address)) {
        candidates.push({ name, addr: a.address })
      }
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => rank(a.name) - rank(b.name))
  return candidates[0].addr
}

export function detectLanIp(): string | null {
  return pickLanIp(os.networkInterfaces())
}
