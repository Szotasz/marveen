/**
 * Resolves the optional tool-name prefix that lets multiple instances of this
 * server run side-by-side without their tool names colliding in MCP clients
 * that disambiguate tools by base name.
 *
 * Precedence: `--tool-prefix=<value>` / `--tool-prefix <value>` CLI flag, then
 * the `GMAIL_MCP_TOOL_PREFIX` env var, then empty string (no prefix — the
 * backward-compatible default).
 *
 * Pure function: argv (already sliced past the node binary and script) and the
 * env map are passed in explicitly, so it is unit-testable without spawning the
 * process.
 *
 * @param args - `process.argv.slice(2)`: CLI args past the node binary and script
 * @param env  - environment map (`process.env`)
 * @returns the resolved prefix, or `''` when none is configured
 */
export function resolveToolPrefix(args: string[], env: NodeJS.ProcessEnv): string {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? '';
        if (arg.startsWith('--tool-prefix=')) {
            return arg.slice('--tool-prefix='.length);
        }
        if (arg === '--tool-prefix' && i + 1 < args.length) {
            return args[i + 1] ?? '';
        }
    }
    return env.GMAIL_MCP_TOOL_PREFIX || '';
}
