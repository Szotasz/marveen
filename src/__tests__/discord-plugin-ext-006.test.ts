// DCEXT1111 (#2787 review, Samu 11-25): discord-plugin-ext.test.ts once more, on the vendored 0.0.6 overlay
// (vendor/discord-plugin/0.0.6), so a fresh install, whose plugin cache holds 0.0.6, is covered too.
process.env.DISCORD_EXT_TEST_VERSION = '0.0.6'
await import('./discord-plugin-ext.test.js')
