# dsh-telegram-bridge

Host-only Cordis bundle for a **single pre-authorized private Telegram chat**. It uses DSH's headless Agent/Session services (no Web server, SessionController or upload endpoint), persists offsets/session/schedule state, and rejects Telegram-based approvals. Text and `/start`, `/help`, `/status`, `/new`, `/compact`, `/stop` only; no pairing, attachments, callback approvals or streaming. Authorized interactive prompts show a best-effort Telegram typing indicator until completion, cancellation or timeout. Credentials and runtime state must stay outside this repository.

## Install

Install the tagged GitHub release into the DSH profile that owns the Telegram bot:

```sh
dsh plugin --profile telegram add 'https://github.com/yoggu/dsh-telegram-bridge.git#v0.1.1'
```

Or download and link a local checkout:

```sh
git clone --branch v0.1.1 --depth 1 https://github.com/yoggu/dsh-telegram-bridge.git
cd dsh-telegram-bridge
pnpm install
dsh plugin --profile telegram add "link:$(pwd)"
```

Keep a linked checkout in place while installed. Use the profile you actually run; the bridge should have its own dedicated DSH process/profile.

## Configure in a consuming DSH profile

After installing the bundle, provide a profile overlay, for example:

```yaml
- id: telegram-bridge
  config:
    cwd: /absolute/agent/workspace
    dataDir: /absolute/private/telegram/data
    agentPreset: existing-agent-preset
    permissionPreset: workspace-write
    provider: existing-local-provider
    model: exact-model-id
    reasoningEffort: low
    timeZone: Europe/Zurich
    enableSchedules: false
    jobs: []
```

The consuming profile owns the `agentPreset` definition (including a compaction service for `/compact`), available tools, model adapter, sandbox/approval policy and optional skill-specific jobs. `/new` durably creates a fresh session immediately; `/compact` runs only on the current idle session and never blindly retries a partially committed operation. `credentials.json` must already exist inside `dataDir`, with private `0600` mode and a private `0700` directory: `{ "botToken": "<token>", "allowedUserId": <numeric-id> }`. The Host never pairs automatically. On startup it registers the current slash-command menu for the authorized private chat via Telegram `setMyCommands`; this menu is separate from the handlers that respond to typed commands. `/status` reports only whether the current session is ready or working and its configured model; it does not expose chat/session identifiers. The bot and its DSH profile must be the only instance polling that token. Do not configure the token or user ID in YAML. DSH state, schedule outbox and exclusive poller socket also live in that data directory. The bundle contains no application-specific persona or workspace path.

All agents in this DSH process are pinned to `cwd` and `workspace-write` on creation; all LLM streams (including auxiliary calls and resumed sessions) are limited to the exact configured provider/model. Give this plugin a **dedicated DSH profile/process**, not one shared with unrelated agents. Configure the deployment's sandbox and permission presets to disallow escalation; the bridge alone cannot prevent direct mode switches in other Host integrations. DSH `workspace-write` also permits temporary `/tmp` writes, global reads and network access. The trusted Host writes its own state outside the agent workspace. Scheduled jobs configured with `read-only` explicitly switch permission presets before prompting.

To opt into scheduled DSH skill prompts, set `enableSchedules: true`, a valid IANA `timeZone` and `jobs` entries with unique ids and `label`, `hour` (0–23), `minute` (0–59), optional `weekday` (`Mon`…`Sun`), `prompt`, and `permissionPreset` (`read-only` or `workspace-write`). For example:

```yaml
    enableSchedules: true
    timeZone: Europe/Zurich
    jobs:
      - id: daily-report
        label: Daily report
        hour: 7
        minute: 0
        prompt: /daily-report
        permissionPreset: read-only
```

The adapter schedules internally, **not** via DSH's reminder plugin. It skips a run more than two minutes late and does not backfill downtime. A slot is pinned before model work: generation runs at most once. Finished text or a failure notice is stored in a durable outbox; Telegram sends are retried with chunk progress, but a transport error after Telegram accepts a chunk can still duplicate that chunk. Interactive inbound updates are acknowledged before execution; crashes can lose an update. This is not exactly-once delivery. Monitor initial timed runs.

For a Web GUI sharing the same session storage, group external Telegram sessions from the **Web Host only** using the optional `workspace-reconciliation.js` plugin (configured with `workspacePath` and `agentPreset`); never mount two workspace registries on the same JSON storage. It scans persisted session headers, attaches matching sessions to an existing workspace, and never starts another Telegram poller.

To uninstall: `dsh plugin --profile telegram remove dsh-telegram-bridge`.

## Tests and license

Run `npm test` after installing the DSH peer dependencies. Requires a DSH `0.1.7-rc.2`- or `0.2.0-rc.1`-compatible installation with the base Agent, Session, SessionQuery, preset registry and Cordis services. Automatic compaction is supplied by the consuming profile's agent preset, not this bridge. MIT; see [LICENSE](LICENSE).
