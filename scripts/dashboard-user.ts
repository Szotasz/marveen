#!/usr/bin/env tsx
// Dashboard browser-login user administration (break-glass). The CLI lives in src/dashboard-user-cli.ts, so tsc
// compiles it into dist/ and a Docker install runs it with node, without a TypeScript runner in the image
// (DOCKERHTTPS1119: `docker compose exec marveen node dist/dashboard-user-cli.js <command>`). This wrapper keeps
// `npm run dashboard-user -- <command>` on a native install exactly as it was.
import '../src/dashboard-user-cli.js'
