import { describe, it, expect } from 'vitest';
import { getAvailableScopeNames, hasScope, scopeNameToUrl } from './scopes.js';
import { getToolByName } from './tools.js';

describe('permanent delete scope requirements', () => {
  it('recognizes gmail.full as the permanent-delete Gmail scope', () => {
    expect(getAvailableScopeNames()).toContain('gmail.full');
    expect(scopeNameToUrl('gmail.full')).toBe('https://mail.google.com/');
  });

  it('does not expose permanent delete tools with only gmail.modify', () => {
    const deleteEmail = getToolByName('delete_email')!;
    const batchDeleteEmails = getToolByName('batch_delete_emails')!;

    expect(deleteEmail.scopes).toEqual(['gmail.full']);
    expect(batchDeleteEmails.scopes).toEqual(['gmail.full']);
    expect(hasScope(['gmail.modify'], deleteEmail.scopes)).toBe(false);
    expect(hasScope(['gmail.modify'], batchDeleteEmails.scopes)).toBe(false);
  });

  it('exposes permanent delete tools with gmail.full shorthand or URL scope', () => {
    const deleteEmail = getToolByName('delete_email')!;
    const batchDeleteEmails = getToolByName('batch_delete_emails')!;

    expect(hasScope(['gmail.full'], deleteEmail.scopes)).toBe(true);
    expect(hasScope(['https://mail.google.com/'], batchDeleteEmails.scopes)).toBe(true);
  });

  it('gmail.full satisfies all mail scopes (superset), so read/send/modify tools stay visible', () => {
    // The README recommends re-authing with --scopes=gmail.full,gmail.settings.basic;
    // without superset handling that combination would hide every non-delete mail tool.
    for (const tool of ['read_email', 'search_emails', 'send_email', 'modify_email', 'create_label']) {
      const t = getToolByName(tool)!;
      expect(hasScope(['gmail.full'], t.scopes), `${tool} should be visible under gmail.full`).toBe(true);
    }
  });

  it('gmail.full does NOT satisfy settings scopes (filters still need gmail.settings.basic)', () => {
    const listFilters = getToolByName('list_filters')!;
    expect(hasScope(['gmail.full'], listFilters.scopes)).toBe(false);
    expect(hasScope(['gmail.full', 'gmail.settings.basic'], listFilters.scopes)).toBe(true);
  });
});
