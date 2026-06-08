import { describe, it, expect } from 'vitest'
import { resolveRemoteConfig } from '../web/agent-config.js'

describe('resolveRemoteConfig', () => {
  it('returns both null for empty / no-remote config (agent is local)', () => {
    expect(resolveRemoteConfig('{}')).toEqual({ host: null, workdir: null })
  })

  it('returns both null for unparseable JSON', () => {
    expect(resolveRemoteConfig('not json')).toEqual({ host: null, workdir: null })
    expect(resolveRemoteConfig('')).toEqual({ host: null, workdir: null })
  })

  it('resolves a valid alias host + absolute workdir', () => {
    expect(resolveRemoteConfig('{"remoteHost":"devbox","remoteWorkdir":"/home/user/proj"}'))
      .toEqual({ host: 'devbox', workdir: '/home/user/proj' })
  })

  it('accepts a user@host form', () => {
    expect(resolveRemoteConfig('{"remoteHost":"user@laptop","remoteWorkdir":"/x/y"}'))
      .toEqual({ host: 'user@laptop', workdir: '/x/y' })
  })

  it('trims surrounding whitespace', () => {
    expect(resolveRemoteConfig('{"remoteHost":"  devbox  ","remoteWorkdir":"  /p  "}'))
      .toEqual({ host: 'devbox', workdir: '/p' })
  })

  it('rejects a host with a colon/port (port belongs in ~/.ssh/config)', () => {
    expect(resolveRemoteConfig('{"remoteHost":"devbox:22","remoteWorkdir":"/x"}'))
      .toEqual({ host: null, workdir: null })
  })

  it('rejects a host with shell metacharacters', () => {
    expect(resolveRemoteConfig('{"remoteHost":"a b; rm -rf","remoteWorkdir":"/x"}'))
      .toEqual({ host: null, workdir: null })
  })

  it('rejects a relative or tilde workdir (encoding must be deterministic)', () => {
    expect(resolveRemoteConfig('{"remoteHost":"devbox","remoteWorkdir":"~/proj"}'))
      .toEqual({ host: null, workdir: null })
    expect(resolveRemoteConfig('{"remoteHost":"devbox","remoteWorkdir":"relative/dir"}'))
      .toEqual({ host: null, workdir: null })
  })

  it('rejects a workdir with a parent-traversal segment', () => {
    expect(resolveRemoteConfig('{"remoteHost":"devbox","remoteWorkdir":"/a/../b"}'))
      .toEqual({ host: null, workdir: null })
  })

  it('treats a half-configured agent (host only / workdir only) as local', () => {
    expect(resolveRemoteConfig('{"remoteHost":"devbox"}')).toEqual({ host: null, workdir: null })
    expect(resolveRemoteConfig('{"remoteWorkdir":"/x"}')).toEqual({ host: null, workdir: null })
    // host valid but workdir invalid => both null
    expect(resolveRemoteConfig('{"remoteHost":"devbox","remoteWorkdir":"bad dir"}'))
      .toEqual({ host: null, workdir: null })
  })
})
