import { t } from './i18n.js'

const ERROR_I18N = {
  not_found:                'errors.not_found',
  required:                 'errors.required',
  invalid_value:            'errors.invalid_value',
  forbidden:                'errors.forbidden',
  unauthorized:             'errors.unauthorized',
  conflict:                 'errors.conflict',
  limit_exceeded:           'errors.limit_exceeded',
  internal_error:           'errors.internal_error',
  parse_error:              'errors.parse_error',
  not_supported:            'errors.not_supported',
  timeout:                  'errors.timeout',
  disabled:                 'errors.disabled',
  managed_settings_missing: 'errors.managed_settings_missing',
  upstream_error:           'errors.upstream_error',
  sender_not_in_allowlist:  'errors.sender_not_in_allowlist',
  federation_disabled:      'errors.federation_disabled',
  unknown_query_parameter:  'errors.unknown_query_parameter',
}

export function getErrorMessage(data, fallback = '') {
  if (!data) return fallback
  if (data.hint) return data.hint
  const key = ERROR_I18N[data.error]
  if (key) return t(key)
  if (data.error) console.warn('[getErrorMessage] unknown error token:', data.error)
  return fallback || t('errors.internal_error')
}
