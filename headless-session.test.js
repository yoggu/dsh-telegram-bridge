import test from 'node:test'
import assert from 'node:assert/strict'
import { createHeadlessSessions } from './headless-session.js'

const config = { cwd: '/srv/assistant', agentPreset: 'telegram', provider: 'local', model: 'qwen', permissionPreset: 'workspace-write', timeZone: 'Europe/Zurich' }
function harness() {
  const live = new Map(), stored = new Map(), calls = [], events = []
  const compaction = { compactNow: async (agent, signal) => { calls.push(['compact', agent.id, signal.aborted]); return { shadowedSeqs: [1, 2], shadowedTokenCount: 128 } } }
  const agentCtx = {}
  const ctx = {
    agentPresets: {
      resolve: async id => ({ id }), mount: async (_ctx, id) => { calls.push(['mount', id]) },
      composedPreset: () => 'telegram', serviceFor: (_agent, key) => key === 'compaction' ? compaction : undefined
    },
    permissionPresets: { set: (session, preset) => calls.push(['permission', session.id, preset]) },
    agents: {
      get: id => live.get(id),
      create: async ({ sessionId, meta, agentOptions, setup }) => {
        assert.equal(agentOptions.model, 'qwen')
        await setup({})
        const session = { id: sessionId, header: { id: sessionId, ...meta } }
        const agent = { id: sessionId, session, status: 'idle', ctx: agentCtx, followup: message => events.push(message), cancel: cause => calls.push(['cancel', cause.kind]) }
        live.set(sessionId, agent)
        stored.set(sessionId, session)
        return { agent, dispose: async () => live.delete(sessionId) }
      },
      resume: async ({ resumeSessionId, agentOptions, setup }) => {
        assert.equal(agentOptions.provider, 'local')
        await setup({})
        const session = stored.get(resumeSessionId)
        const agent = { id: resumeSessionId, session, status: 'idle', ctx: agentCtx, followup: message => events.push(message), cancel: cause => calls.push(['cancel', cause.kind]) }
        live.set(resumeSessionId, agent)
        return { agent, dispose: async () => live.delete(resumeSessionId) }
      }
    },
    sessionQuery: { observeSession: async id => {
      const header = stored.get(id)?.header
      if (!header) throw new Error('not found')
      return { header, projections: { values: { agentPreset: header.agentPreset } }, [Symbol.dispose]() {} }
    } }
  }
  return { ctx, live, stored, calls, events }
}
test('headless sessions create, correlate prompt, and retain permission', async () => {
  const h = harness(), sessions = createHeadlessSessions(h.ctx, config)
  let saved
  const first = await sessions.acquire(null, 'workspace-write', id => { saved = id })
  assert.equal(first.session.id, saved)
  assert.equal(sessions.status(saved), 'idle')
  first.status = 'running'
  assert.equal(sessions.status(saved), 'running')
  assert.equal(sessions.status('foreign'), null)
  sessions.prompt(saved, 'Ping', 'rpc-1')
  assert.equal(h.events[0].source.rpcId, 'rpc-1')
  assert.equal(h.events[0].source.clientTimeZone, 'Europe/Zurich')
  sessions.cancel(saved)
  assert.ok(h.calls.some(call => call[0] === 'cancel'))
  await sessions.dispose()
  assert.equal(h.live.size, 0)
  assert.equal(sessions.status(saved), null)
})
test('manual compaction acts on the exact owned agent, not stale or foreign ids', async () => {
  const h = harness(), sessions = createHeadlessSessions(h.ctx, config)
  let id
  await sessions.acquire(null, 'workspace-write', value => { id = value })
  const signal = new AbortController().signal
  assert.deepEqual(await sessions.compact(id, signal), { shadowedSeqs: [1, 2], shadowedTokenCount: 128 })
  assert.deepEqual(h.calls.find(call => call[0] === 'compact'), ['compact', id, false])
  assert.throws(() => sessions.compact('foreign', signal), /unavailable/)
  await sessions.dispose()
  assert.throws(() => sessions.compact(id, signal), /unavailable/)
})
test('headless resume rejects foreign workspace and preset before dispatch', async () => {
  const h = harness(), sessions = createHeadlessSessions(h.ctx, config)
  let id
  await sessions.acquire(null, 'workspace-write', value => { id = value })
  await sessions.dispose()
  const second = createHeadlessSessions(h.ctx, config)
  const restored = await second.acquire(id, 'read-only', () => { throw new Error('unexpected write') })
  assert.equal(restored.session.id, id)
  assert.ok(h.calls.some(call => call[0] === 'permission' && call[2] === 'read-only'))
  await second.dispose()
  h.stored.get(id).header.cwd = '/srv/other'
  await assert.rejects(createHeadlessSessions(h.ctx, config).acquire(id, 'workspace-write', () => {}), /identity mismatch/)
})
