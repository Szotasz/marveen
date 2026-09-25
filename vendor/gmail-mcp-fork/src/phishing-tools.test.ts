import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ReportPhishingSchema,
    BatchReportPhishingSchema,
    getToolByName,
    toolDefinitions,
} from './tools.js';
import { hasScope } from './scopes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = __dirname;

describe('ReportPhishingSchema', () => {
    it('parses valid single-message input', () => {
        const result = ReportPhishingSchema.parse({ messageId: 'msg123' });
        expect(result.messageId).toBe('msg123');
    });

    it('rejects missing messageId', () => {
        expect(() => ReportPhishingSchema.parse({})).toThrow();
    });
});

describe('BatchReportPhishingSchema', () => {
    it('parses valid batch input', () => {
        const result = BatchReportPhishingSchema.parse({
            messageIds: ['a', 'b'],
            batchSize: 10,
        });
        expect(result.messageIds).toEqual(['a', 'b']);
        expect(result.batchSize).toBe(10);
    });

    it('defaults batchSize to 50', () => {
        const result = BatchReportPhishingSchema.parse({
            messageIds: ['a'],
        });
        expect(result.batchSize).toBe(50);
    });
});

describe('Phishing tool definitions', () => {
    it('registers report_phishing in toolDefinitions', () => {
        const tool = getToolByName('report_phishing');
        expect(tool).toBeDefined();
        expect(tool!.name).toBe('report_phishing');
        expect(tool!.scopes).toContain('gmail.modify');
    });

    it('registers batch_report_phishing in toolDefinitions', () => {
        const tool = getToolByName('batch_report_phishing');
        expect(tool).toBeDefined();
        expect(tool!.name).toBe('batch_report_phishing');
        expect(tool!.scopes).toContain('gmail.modify');
    });

    it('includes both phishing tools in the global tool list', () => {
        const phishingTools = toolDefinitions.filter(t =>
            ['report_phishing', 'batch_report_phishing'].includes(t.name)
        );
        expect(phishingTools).toHaveLength(2);
    });

    it('makes phishing tools available with gmail.modify scope', () => {
        const singleTool = getToolByName('report_phishing')!;
        const batchTool = getToolByName('batch_report_phishing')!;
        expect(hasScope(['gmail.modify'], singleTool.scopes)).toBe(true);
        expect(hasScope(['gmail.modify'], batchTool.scopes)).toBe(true);
    });
});

describe('Source verification', () => {
    it('single phishing report uses SPAM label flow', () => {
        const source = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf-8');
        expect(source).toContain('case "report_phishing"');
        expect(source).toContain("addLabelIds: ['SPAM']");
        expect(source).toContain('closest public Gmail API approximation of reporting phishing');
        expect(source).toContain('does not expose the full native Report phishing workflow');
    });

    it('batch phishing report uses batchModify with SPAM label flow and documents limitation', () => {
        const source = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf-8');
        expect(source).toContain('case "batch_report_phishing"');
        expect(source).toContain('gmail.users.messages.batchModify');
        expect(source).toContain('ids: batch');
        expect(source).toContain('Batch phishing report complete.');
        expect(source).toContain('closest public Gmail API approximation of reporting phishing');
        expect(source).toContain('does not expose the full native Report phishing workflow');
    });
});
