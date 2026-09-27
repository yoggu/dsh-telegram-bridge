import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileWorkspaceSessions } from './workspace-reconciliation.js'

test('groups existing and later persisted Telegram sessions, not other sessions', async () => {
  const sessionIds = ['already']
  const workspace = { id: 'telegram', path: '/srv/telegram', get sessionIds() { return [...sessionIds] }, async attachSession(id) { sessionIds.unshift(id) } }
  const headers = [
    { id: 'already', cwd: '/srv/telegram', agentPreset: 'telegram' },
    { id: 'prior-test', cwd: '/srv/telegram', agentPreset: 'telegram' },
    { id: 'other-preset', cwd: '/srv/telegram', agentPreset: 'web' },
    { id: 'other-workspace', cwd: '/srv/other', agentPreset: 'telegram' },
    { id: 'subagent', cwd: '/srv/telegram', agentPreset: 'telegram', origin: 'subagent' }
  ]
  const ctx = {
    workspaceRegistry: { resolveByPath: async path => path === '/srv/telegram' ? workspace : undefined, list: () => [workspace] },
    sessionPersistence: { list: async () => headers.map(header => ({ header })) }
  }
  const config = { workspacePath: '/srv/telegram', agentPreset: 'telegram' }
  assert.equal(await reconcileWorkspaceSessions(ctx, config), 1)
  assert.deepEqual(sessionIds, ['prior-test', 'already'])
  headers.push({ id: 'later', cwd: '/srv/telegram', agentPreset: 'telegram' })
  assert.equal(await reconcileWorkspaceSessions(ctx, config), 1)
  assert.equal(await reconcileWorkspaceSessions(ctx, config), 0)
  assert.deepEqual(sessionIds, ['later', 'prior-test', 'already'])
})

test('does not create a workspace or reassign another workspace membership', async () => {
  const workspace = { id: 'telegram', path: '/srv/telegram', sessionIds: [], async attachSession() { throw new Error('should not attach') } }
  const ctx = {
    workspaceRegistry: { resolveByPath: async () => workspace, list: () => [workspace, { id: 'other', sessionIds: ['foreign'] }] },
    sessionPersistence: { list: async () => [{ header: { id: 'foreign', cwd: '/srv/telegram', agentPreset: 'telegram' } }] }
  }
  assert.equal(await reconcileWorkspaceSessions(ctx, { workspacePath: '/srv/telegram', agentPreset: 'telegram' }), 0)
  await assert.rejects(reconcileWorkspaceSessions({ ...ctx, workspaceRegistry: { resolveByPath: async () => undefined } }, { workspacePath: '/srv/telegram', agentPreset: 'telegram' }), /does not exist/)
})
