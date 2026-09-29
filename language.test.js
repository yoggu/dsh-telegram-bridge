import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { Config } from './config.js'
import { authorized, chunks, sendText, validateBridgeConfig, withDeadline } from './core.js'
import { formatStatus, syncPrivateCommands } from './commands.js'

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
const runnable = source.replace(/^import .*\n/gm, '').replace(/^export \{ Config \}.*\n/m, '').replace(/^export /gm, '') + '\nglobalThis.mount = apply'
const config = { cwd: '/mock/workspace', dataDir: '/mock/private', agentPreset: 'test', permissionPreset: 'workspace-write', provider: 'test', model: 'mock-model' }

test('host-only English metadata/help covers all public settings without exposing secrets', () => {
  assert.equal(Config.dict.language.meta.default, 'en')
  assert.equal(Config.dict.enableSchedules.meta.default, false)
  assert.equal(Config.dict.timeZone.meta.default, 'UTC')
  for (const field of Object.values(Config.dict)) assert.ok(field.meta.description)
  for (const field of Object.values(Config.dict.jobs.inner.dict)) assert.ok(field.meta.description)
  assert.equal(Config.dict.botToken, undefined)
  assert.equal(Config.dict.allowedUserId, undefined)
  assert.equal(Config({ ...config }).language, 'en')
  const locale = JSON.parse(readFileSync(new URL('./locale/en.json', import.meta.url), 'utf8'))
  assert.match(locale.meta.title, /Telegram bridge/)
  assert.match(locale.meta.description, /Host-only/)
})

test('bridge-owned help/errors/events are bilingual with mocked transport, state, sessions, and credentials', async () => {
  for (const language of [undefined, 'en', 'unsupported', 'de']) {
    const sent = []
    const events = new Map()
    let dispose
    let finish
    let activeSession = false
    const done = new Promise(resolve => { finish = resolve })
    const inputs = ['/help', '/status x', '/status', '/new x', '/compact', '/new', '/status', '/compact x', '/compact', '/compact', '/compact', '/compact', '/compact', '/compact', '/compact', '/compact', '/compact', '/stop', '/unknown', 'hello', 'x'.repeat(16001), null]
    const updates = inputs.map((text, index) => ({ update_id: index + 1, message: { text, chat: { type: 'private', id: 123 }, from: { id: 123 } } }))
    const failures = [null, { shadowedSeqs: [1, 2], shadowedTokenCount: 10 }, ...['busy', 'cancelled', 'changed', 'summary', 'commit', 'persistence', 'other'].map(code => Object.assign(new Error('private error'), { name: 'ManualCompactionError', code }))]
    let polled = false
    const api = async (method, payload, signal) => {
      if (method === 'getUpdates') {
        if (!polled) { polled = true; return updates }
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      }
      if (method === 'sendMessage') {
        sent.push(payload.text)
        if (sent.length === inputs.length) finish()
      }
      return true
    }
    const context = {
      randomUUID: () => 'mock-id', realpath: async value => value,
      // These are mocks, not private-file reads/writes or a Telegram send.
      loadCredentials: async () => ({ userId: 123, token: 'mock', offset: 0 }),
      loadState: async () => ({ sessionId: null, offset: 0 }), loadScheduleState: async () => ({ jobs: {} }), saveState: async () => {},
      telegramApi: () => api, acquirePollerLock: async () => async () => {},
      validateBridgeConfig, authorized, sendText, chunks, withDeadline, formatStatus, syncPrivateCommands,
      restrictModel: () => {}, confineAgent: () => {},
      createSchedule: () => ({ jobs: [] }),
      createTypingNotifier: () => ({ start: () => () => {}, dispose: () => {} }),
      createHeadlessSessions: () => ({
        acquire: async (_id, _permission, save) => { activeSession = true; await save('mock-session'); return { session: { id: 'mock-session' } } },
        status: () => activeSession ? 'ready' : null,
        cancel: () => {}, dispose: async () => {},
        compact: async () => { const result = failures.shift(); if (result instanceof Error) throw result; return result },
        prompt: (_id, _text, requestId) => {
          events.get('agent/inbox/claimed')({ agent: { session: { id: 'mock-session' } }, message: { source: { rpcId: requestId } }, turn: 1 })
          events.get('session/event')({ id: 'mock-session' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
        },
      }),
      AbortController, Promise, setTimeout: () => 0, clearTimeout: () => {},
      console: { error: () => {}, info: () => {} },
    }
    runInNewContext(runnable, context)
    context.mount({ on: (name, fn) => { events.set(name, fn) }, effect: fn => { dispose = fn() }, logger: { info: () => {}, warn: () => {}, error: () => {} } }, { ...config, language })
    await done
    await dispose()
    const copy = sent.join('\n')
    if (language === 'de') {
      for (const expected of ['Textnachrichten', 'Verwendung: /status', 'Noch keine Sitzung', 'Neue Sitzung erstellt', 'Kontext verdichtet', 'Stopp angefordert', 'Unbekannter Befehl', 'keine Textantwort', 'Nachricht zu lang']) assert.ok(copy.includes(expected), expected)
    } else {
      for (const expected of ['Send text messages', 'Usage: /status', 'No session yet', 'New session created', 'Context compacted', 'Session busy', 'Compaction cancelled', 'History changed', 'No usable summary', 'did not finish cleanly', 'could not be saved', 'Compaction failed', 'Stop requested', 'Unknown command', 'no text response', 'Message too long', 'Only text messages']) assert.ok(copy.includes(expected), expected)
      assert.doesNotMatch(copy, /Verwendung|Sitzung|Verdichtung|Unbekannter|private error/)
    }
  }
})
