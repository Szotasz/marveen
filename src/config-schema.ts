import { z } from 'zod'

// Hex color: #rrggbb
const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex color (#rrggbb)')
  .optional()

// Non-negative integer coerced from string
const nonNegInt = z.coerce.number().int().min(0).optional()

// Hour of day (0-23)
const hourField = z.coerce.number().int().min(0).max(23).optional()

// Port number (1-65535)
const portField = z.coerce.number().int().min(1).max(65535).optional()

// Percentage (0-100)
const pctField = z.coerce.number().int().min(0).max(100).optional()

// Positive duration in ms
const posMs = z.coerce.number().int().min(1).optional()

// Fields that are validated when present. All optional at the schema level
// (defaults come from the existing config.ts constants); the function below
// applies NODE_ENV-conditional FATAL checks on top.
export const envSchema = z.object({
  // Channel
  CHANNEL_PROVIDER: z
    .enum(['telegram', 'slack', 'discord', 'googlechat', 'teams'])
    .optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  ALLOWED_CHAT_ID: z.string().optional(),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_CHANNEL_ID: z.string().optional(),
  // Identity
  OWNER_NAME: z.string().optional(),
  OWNER_DRIVE_FOLDER: z.string().optional(),
  BOT_NAME: z.string().optional(),
  BRAND_NAME: z.string().optional(),
  MAIN_AGENT_ID: z.string().min(1, 'must not be empty').optional(),
  SERVICE_ID: z.string().optional(),
  DEFAULT_AGENT_MODEL: z.string().optional(),
  // Web
  WEB_PORT: portField,
  WEB_HOST: z.string().optional(),
  DASHBOARD_PUBLIC_URL: z.string().optional(),
  DASHBOARD_ALLOWED_ORIGINS: z.string().optional(),
  OLLAMA_URL: z.string().url('must be a valid URL').optional(),
  // Kanban aging thresholds
  KANBAN_AGING_WARN_H: nonNegInt,
  KANBAN_AGING_CAUTION_H: nonNegInt,
  KANBAN_AGING_CRITICAL_H: nonNegInt,
  KANBAN_AGING_WARN_COLOR: hexColor,
  KANBAN_AGING_CAUTION_COLOR: hexColor,
  KANBAN_AGING_CRITICAL_COLOR: hexColor,
  // Kanban WIP
  KANBAN_WIP_PLANNED: nonNegInt,
  KANBAN_WIP_IN_PROGRESS: nonNegInt,
  KANBAN_WIP_TESTING: nonNegInt,
  KANBAN_WIP_WAITING: nonNegInt,
  KANBAN_WIP_DONE: nonNegInt,
  KANBAN_WIP_WARN_PCT: pctField,
  KANBAN_WIP_OK_COLOR: hexColor,
  KANBAN_WIP_WARN_COLOR: hexColor,
  KANBAN_WIP_FULL_COLOR: hexColor,
  KANBAN_WIP_OVER_COLOR: hexColor,
  KANBAN_SWIMLANE_DEFAULT_GROUP: z
    .enum(['assignee', 'priority', 'none'])
    .optional(),
  KANBAN_SWIMLANE_SEPARATOR_COLOR: z.string().optional(),
  KANBAN_LABEL_COLORS: z.string().optional(),
  // Respawn gate
  RESPAWN_ENABLED: z.string().optional(),
  RESPAWN_HOST: z.string().optional(),
  // Heartbeat
  HEARTBEAT_INTERVAL_MS: posMs,
  HEARTBEAT_START_HOUR: hourField,
  HEARTBEAT_END_HOUR: hourField,
  HEARTBEAT_AGENT_ENABLED: z.string().optional(),
  HEARTBEAT_CALENDAR_ACCOUNT: z.string().optional(),
  HEARTBEAT_CALENDAR_ID: z.string().optional(),
  // Inbox tee
  SUBAGENT_INBOX_TEE: z.string().optional(),
  SUBAGENT_TELEGRAM_WAKE_ENABLED: z.string().optional(),
})

export type EnvSchema = z.infer<typeof envSchema>

// Fields that cause a hard boot failure in production when invalid.
const FATAL_PROD_FIELDS = new Set(['WEB_PORT', 'OLLAMA_URL'])

/**
 * Validate env-var-based config scalars at boot time.
 * - Format errors on FATAL_PROD_FIELDS in production: throw (hard stop).
 * - Format errors on other fields: console.warn (degraded-mode continue).
 * - Cross-field production check: TELEGRAM_BOT_TOKEN required when CHANNEL_PROVIDER=telegram.
 *
 * Does NOT replace any existing exports -- purely additive side-effect validation.
 *
 * @param rawEnv  Merged env object: { ...readEnvFile(), ...readConfigOverrides() }
 * @param isProd  true when NODE_ENV === 'production'
 */
export function validateEnvConfig(rawEnv: Record<string, unknown>, isProd: boolean): void {
  const result = envSchema.safeParse(rawEnv)

  if (!result.success) {
    const issues = result.error.issues

    const fatal: string[] = []
    const warnings: string[] = []

    for (const issue of issues) {
      const field = String(issue.path[0] ?? '(unknown)')
      const msg = `[config] ${field}: ${issue.message}`
      if (isProd && FATAL_PROD_FIELDS.has(field)) {
        fatal.push(msg)
      } else {
        warnings.push(msg)
      }
    }

    for (const w of warnings) {
      console.warn(w)
    }

    if (fatal.length > 0) {
      throw new Error(`Fatal config validation errors:\n${fatal.join('\n')}`)
    }
  }

  // Cross-field production check: channel token must be set for the active provider.
  if (isProd) {
    const provider = (rawEnv['CHANNEL_PROVIDER'] as string | undefined) ?? 'telegram'
    if (provider === 'telegram' && !rawEnv['TELEGRAM_BOT_TOKEN']) {
      throw new Error(
        '[config] Fatal: TELEGRAM_BOT_TOKEN is required in production when CHANNEL_PROVIDER=telegram',
      )
    }
    if (provider === 'slack' && !rawEnv['SLACK_BOT_TOKEN']) {
      throw new Error(
        '[config] Fatal: SLACK_BOT_TOKEN is required in production when CHANNEL_PROVIDER=slack',
      )
    }
  }
}
