import Schema from '@deepseek-ai/schemastery'

// Non-volatile: these settings are read when the dedicated Host mounts the bridge.
// Tokens and authorized chat IDs intentionally remain outside the public schema.
export const Config = Schema.object({
  cwd: Schema.string().required().description('Canonical absolute working folder for all Telegram agents.'),
  dataDir: Schema.string().required().description('Private absolute data directory containing credentials and bridge state. Do not enter a token here.'),
  agentPreset: Schema.string().required().description('Existing agent preset used for Telegram sessions.'),
  permissionPreset: Schema.const('workspace-write').required().description('Interactive session permission preset; must be workspace-write.'),
  provider: Schema.string().required().description('Only this configured model provider is allowed.'),
  model: Schema.string().required().description('Exact model ID permitted for all model calls.'),
  reasoningEffort: Schema.string().description('Optional reasoning effort supported by the configured model.'),
  language: Schema.union(['en', 'de']).default('en').description('Command menu and bridge messages: English (default) or German. Model answers are not translated.'),
  timeZone: Schema.string().default('UTC').description('IANA time zone for scheduled jobs and interactive prompts.'),
  enableSchedules: Schema.boolean().default(false).description('Enable scheduled jobs. Disabled by default.'),
  jobs: Schema.array(Schema.object({
    id: Schema.string().required().description('Unique scheduled job ID, using lowercase letters, digits, and hyphens.'),
    label: Schema.string().required().description('Job label included in the Telegram notification.'),
    hour: Schema.number().min(0).max(23).step(1).required().description('Local hour (0–23).'),
    minute: Schema.number().min(0).max(59).step(1).required().description('Local minute (0–59).'),
    weekday: Schema.union(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']).description('Optional weekday. Leave unset to run daily.'),
    prompt: Schema.string().required().description('Trusted scheduled prompt or skill command. User-provided content is not translated.'),
    permissionPreset: Schema.union(['read-only', 'workspace-write']).required().description('Permission preset for this scheduled job.'),
  })).default([]).description('Optional scheduled jobs; generation is never automatically replayed.'),
}).description('Dedicated host-only Telegram bridge settings. No browser plugin is required.')
