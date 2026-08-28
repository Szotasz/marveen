"""
Consistency test: every error token in ERROR_TOKENS (api-error-catalog.ts) must have
an entry in the ERROR_I18N map (error-message.js) AND a translation in both hu.js and
en.js. Dead lang keys (errors.* present in lang files but absent from the map) are also
flagged to catch stale cleanup debt.

Runs automatically in CI: .github/workflows/ci.yml iterates scripts/__tests__/*.test.py.
"""
import os, re, sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))


def read(rel):
    return open(os.path.join(ROOT, rel), encoding='utf-8').read()


def extract_catalog_tokens(src):
    """Extract string literals from the ERROR_TOKENS array in api-error-catalog.ts."""
    m = re.search(r'export const ERROR_TOKENS\s*=\s*\[(.*?)\]\s*as const', src, re.DOTALL)
    if not m:
        raise ValueError("ERROR_TOKENS array not found in api-error-catalog.ts")
    return set(re.findall(r"'([a-z_]+)'", m.group(1)))


def extract_i18n_map(src):
    """Extract {token: 'errors.key'} from the ERROR_I18N object in error-message.js."""
    m = re.search(r'const ERROR_I18N\s*=\s*\{(.*?)\}', src, re.DOTALL)
    if not m:
        raise ValueError("ERROR_I18N object not found in error-message.js")
    pairs = re.findall(r'(\w+)\s*:\s*\'(errors\.\w+)\'', m.group(1))
    return {token: key for token, key in pairs}


def extract_lang_error_keys(src):
    """Extract all 'errors.*' key strings from a lang file."""
    return set(re.findall(r"'(errors\.[a-z_]+)'", src))


catalog_tokens = extract_catalog_tokens(read('src/api-error-catalog.ts'))
i18n_map       = extract_i18n_map(read('web/modules/error-message.js'))
hu_keys        = extract_lang_error_keys(read('web/lang/hu.js'))
en_keys        = extract_lang_error_keys(read('web/lang/en.js'))
all_map_keys   = set(i18n_map.values())

failures = []

# [1] Every catalog token must appear in ERROR_I18N map
for token in sorted(catalog_tokens):
    if token not in i18n_map:
        failures.append(
            f"ERROR_I18N map missing: '{token}' is in ERROR_TOKENS but has no entry in error-message.js"
        )

# [2] Every map key must appear in both hu.js and en.js
for token in sorted(i18n_map):
    key = i18n_map[token]
    if key not in hu_keys:
        failures.append(f"hu.js missing translation: '{key}' (token: '{token}')")
    if key not in en_keys:
        failures.append(f"en.js missing translation: '{key}' (token: '{token}')")

# [3] Dead lang keys: errors.* in lang files but not in ERROR_I18N map
for key in sorted(hu_keys | en_keys):
    if key not in all_map_keys:
        failures.append(
            f"Dead lang key: '{key}' exists in lang file(s) but not in ERROR_I18N map"
        )

if failures:
    for msg in failures:
        print(f"FAIL: {msg}")
    sys.exit(1)

print(
    f"OK: {len(catalog_tokens)} tokens, {len(i18n_map)} map entries, "
    f"hu+en complete, no dead keys"
)
