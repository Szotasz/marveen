import { describe, it, expect } from 'vitest';
import { resolveToolPrefix } from './tool-prefix.js';

const NO_ENV: NodeJS.ProcessEnv = {};

describe('resolveToolPrefix', () => {
    describe('default (backward compatibility)', () => {
        it('returns empty string when no args and no env var', () => {
            expect(resolveToolPrefix([], NO_ENV)).toBe('');
        });

        it('returns empty string for unrelated args', () => {
            expect(resolveToolPrefix(['auth', '--scopes=gmail.readonly'], NO_ENV)).toBe('');
        });
    });

    describe('--tool-prefix=<value> form', () => {
        it('parses the value after the equals sign', () => {
            expect(resolveToolPrefix(['--tool-prefix=personal_'], NO_ENV)).toBe('personal_');
        });

        it('treats an empty value as no prefix', () => {
            expect(resolveToolPrefix(['--tool-prefix='], NO_ENV)).toBe('');
        });

        it('finds the flag among other args', () => {
            expect(resolveToolPrefix(['--scopes=gmail.modify', '--tool-prefix=info_'], NO_ENV)).toBe('info_');
        });

        it('preserves a value that itself contains an equals sign', () => {
            expect(resolveToolPrefix(['--tool-prefix=a=b_'], NO_ENV)).toBe('a=b_');
        });
    });

    describe('--tool-prefix <value> (space-separated) form', () => {
        it('parses the value in the next argv slot', () => {
            expect(resolveToolPrefix(['--tool-prefix', 'shared_'], NO_ENV)).toBe('shared_');
        });

        it('falls through when the flag is the final arg with no value', () => {
            expect(resolveToolPrefix(['--tool-prefix'], NO_ENV)).toBe('');
        });
    });

    describe('GMAIL_MCP_TOOL_PREFIX env var fallback', () => {
        it('uses the env var when no CLI flag is present', () => {
            expect(resolveToolPrefix([], { GMAIL_MCP_TOOL_PREFIX: 'envprefix_' })).toBe('envprefix_');
        });

        it('treats an empty env var as no prefix', () => {
            expect(resolveToolPrefix([], { GMAIL_MCP_TOOL_PREFIX: '' })).toBe('');
        });
    });

    describe('precedence', () => {
        it('CLI flag (=form) overrides the env var', () => {
            expect(resolveToolPrefix(['--tool-prefix=cli_'], { GMAIL_MCP_TOOL_PREFIX: 'env_' })).toBe('cli_');
        });

        it('CLI flag (space form) overrides the env var', () => {
            expect(resolveToolPrefix(['--tool-prefix', 'cli_'], { GMAIL_MCP_TOOL_PREFIX: 'env_' })).toBe('cli_');
        });

        it('first --tool-prefix occurrence wins when the flag is repeated', () => {
            expect(resolveToolPrefix(['--tool-prefix=first_', '--tool-prefix=second_'], NO_ENV)).toBe('first_');
        });
    });
});
