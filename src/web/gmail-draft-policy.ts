// GMAILDRAFT1116: which sub-agents may call POST /api/gmail/draft. Its own module so the auth gate can read it without
// loading the draft writer (and the vault) into every request. Default: none (the setting is empty).
import { getEffectiveSettingValue } from '../settings-store.js'

export function gmailDraftAgents(): Set<string> {
  return new Set(String(getEffectiveSettingValue('GMAIL_DRAFT_AGENTS') ?? '').split(',').map(s => s.trim()).filter(Boolean))
}
