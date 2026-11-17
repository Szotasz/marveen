// Released agent package signing keys (MIOAGENTINSTALL1114, plan 9.1; contract Sz-4.6).
//
// Public keys only, in the contract's JWK shape:
//   {"kty":"OKP","crv":"Ed25519","x":"<base64url>","kid":"<kid>"}
// The list may hold the current AND the next kid during a key rotation; a
// package signed with either is valid. It is EMPTY until the publisher hands
// over the public key (N3): until then every install in a released build is
// refused with unknown_kid. A test key never belongs here; a pinning test
// checks the kid and x pairs against a fixed set.

import type { Jwk } from './verify.js'

export const RELEASED_KEYS: readonly Jwk[] = Object.freeze([])
