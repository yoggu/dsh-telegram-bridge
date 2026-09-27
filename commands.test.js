import test from 'node:test'
import assert from 'node:assert/strict'
import { commandMenu, formatStatus, syncPrivateCommands } from './commands.js'

test('private chat menu includes every supported safe command', async () => {
  const calls = []
  await syncPrivateCommands(async (method, payload) => calls.push([method, payload]), 123)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'setMyCommands')
  assert.deepEqual(calls[0][1].scope, { type: 'chat', chat_id: 123 })
  assert.deepEqual(commandMenu.map(entry => entry.command), ['start', 'help', 'status', 'new', 'compact', 'stop'])
  assert.ok(commandMenu.every(entry => entry.description.length >= 1 && entry.description.length <= 256))
  await assert.rejects(syncPrivateCommands(() => { throw new Error('unexpected API call') }, 0), /Private chat ID/)
})
test('status contains only minimal model and session activity, no ids', () => {
  assert.equal(formatStatus({ hasSession: false, active: false, model: 'qwen' }), 'DSH: Noch keine Sitzung.\nModell: qwen')
  assert.equal(formatStatus({ hasSession: true, active: true, model: 'qwen' }), 'DSH: Sitzung arbeitet.\nModell: qwen')
  assert.equal(formatStatus({ hasSession: true, active: false, model: 'qwen' }), 'DSH: Sitzung bereit.\nModell: qwen')
})
