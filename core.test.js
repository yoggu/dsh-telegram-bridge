import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorized, chunks, saveState, loadState, loadScheduleState, loadCredentials, telegramApi, acquirePollerLock, restrictModel, confineAgent, validateBridgeConfig } from './core.js'

test('a deployment supplies its own workspace, data dir, model and preset', () => {
  const paths = validateBridgeConfig({ cwd: '/srv/example', dataDir: '/home/demo/.config/bridge', agentPreset: 'assistant', provider: 'local', model: 'demo', permissionPreset: 'workspace-write' })
  assert.equal(paths.credentials, '/home/demo/.config/bridge/credentials.json')
  assert.equal(paths.lock, '/home/demo/.config/bridge/dsh-poller.sock')
  assert.throws(() => validateBridgeConfig({ cwd: '/srv/example' }), /Invalid Telegram bridge configuration/)
})

test('private chat and pinned sender are both required', () => {
  const id = 42
  assert.equal(authorized({ message: { chat: { id, type: 'private' }, from: { id }, text: 'hi' } }, id), true)
  assert.equal(authorized({ message: { chat: { id, type: 'group' }, from: { id } } }, id), false)
  assert.equal(authorized({ message: { chat: { id, type: 'private' }, from: { id: 43 } } }, id), false)
  assert.equal(authorized({ callback_query: { from: { id }, message: { chat: { id: 43, type: 'private' } } } }, id), false)
  assert.equal(authorized({ edited_message: { chat: { id, type: 'private' }, from: { id } } }, id), false)
})

test('text chunks preserve unicode code points', () => {
  assert.deepEqual(chunks('😀😀😀', 4), ['😀😀', '😀'])
  assert.deepEqual(chunks(''), [])
})

test('protected state persists offset and session across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'telegram-bridge-'))
  const path = join(dir, 'state.json')
  assert.deepEqual(await loadState(path, 17), { offset: 17, sessionId: null })
  await saveState(path, { offset: 18, sessionId: 's-1' })
  assert.deepEqual(await loadState(path, 17), { offset: 18, sessionId: 's-1' })
  assert.equal((await readFile(path, 'utf8')).includes('s-1'), true)
})

test('credentials require an already paired user and private file mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'telegram-bridge-'))
  const path = join(dir, 'credentials.json')
  await saveState(path, { botToken: '123:fake', allowedUserId: 42, lastUpdateId: 9 })
  assert.deepEqual(await loadCredentials(path), { token: '123:fake', userId: 42, offset: 10 })
  await chmod(path, 0o644)
  await assert.rejects(loadCredentials(path), /private regular file/)
})

test('only one poller owns a socket and it releases on shutdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'telegram-bridge-'))
  const path = join(dir, 'poller.sock')
  const release = await acquirePollerLock(path)
  await assert.rejects(acquirePollerLock(path), /already active/)
  await release()
  const release2 = await acquirePollerLock(path)
  await release2()
})

test('schedule state stays private and roundtrips outbox progress', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'telegram-bridge-'))
  const path = join(dir, 'schedule.json')
  assert.deepEqual(await loadScheduleState(path), { jobs: {} })
  await saveState(path, { jobs: { briefing: { status: 'generated', outbox: { text: 'ok', nextChunk: 1 } } } })
  assert.equal((await loadScheduleState(path)).jobs.briefing.outbox.nextChunk, 1)
})

test('only the configured route reaches an LLM adapter', () => {
  let dispatched = 0
  const next = () => { dispatched++; return 'stream' }
  assert.equal(restrictModel({ provider: 'local', model: 'demo-model' }, next, 'local', 'demo-model'), 'stream')
  assert.throws(() => restrictModel({ provider: 'remote', model: 'demo-model' }, next, 'local', 'demo-model'), /TELEGRAM_MODEL_RESTRICTED/)
  assert.throws(() => restrictModel({ provider: 'local', model: 'other' }, next, 'local', 'demo-model'), /TELEGRAM_MODEL_RESTRICTED/)
  assert.equal(dispatched, 1)
})

test('agent initialization rejects other workspaces and pins permission', () => {
  const session = { header: { cwd: '/srv/example' } }
  const calls = []
  const permissions = { set: (...args) => calls.push(args) }
  confineAgent({ session }, '/srv/example', permissions)
  assert.deepEqual(calls, [[session, 'workspace-write']])
  assert.throws(() => confineAgent({ session: { header: { cwd: '/srv/other' } } }, '/srv/example', permissions), /TELEGRAM_WORKSPACE_RESTRICTED/)
  assert.equal(calls.length, 1)
})

test('API errors never reveal token or remote response body', async () => {
  const api = telegramApi('123:fake', async () => ({ ok: false, status: 401, json: async () => ({ description: '123:fake' }) }))
  await assert.rejects(api('getUpdates'), error => !error.message.includes('secret') && /HTTP 401/.test(error.message))
})
