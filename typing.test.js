import test from 'node:test'
import assert from 'node:assert/strict'
import { createTypingNotifier } from './typing.js'

async function drain() { await Promise.resolve(); await Promise.resolve() }
function clock() {
  let time = 0
  let nextId = 0
  const timers = new Map()
  return {
    now: () => time,
    schedule(fn, delay) { const id = ++nextId; timers.set(id, { at: time + delay, fn }); return id },
    clear(id) { timers.delete(id) },
    async advance(ms) {
      const limit = time + ms
      while (true) {
        const due = [...timers].filter(([, value]) => value.at <= limit).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        time = due[1].at
        timers.delete(due[0])
        due[1].fn()
        await drain()
      }
      time = limit
    },
    get pending() { return timers.size }
  }
}
test('typing starts immediately, refreshes without overlapping and stops', async () => {
  const timer = clock(), calls = []
  let release
  const api = async (_method, params, signal) => { calls.push({ params, signal }); await new Promise(resolve => { release = resolve }) }
  const notifier = createTypingNotifier(api, 4, timer)
  const stop = notifier.start()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].params, { chat_id: 4, action: 'typing' })
  await timer.advance(12000)
  assert.equal(calls.length, 1)
  release()
  await drain()
  await timer.advance(4000)
  assert.equal(calls.length, 2)
  stop()
  assert.equal(calls[1].signal.aborted, true)
  await timer.advance(10000)
  assert.equal(calls.length, 2)
  notifier.dispose()
})
test('typing failures back off, including Telegram rate limit, without rejection', async () => {
  const timer = clock(), calls = []
  const notifier = createTypingNotifier(async () => { calls.push(timer.now()); throw new Error('Telegram sendChatAction HTTP 429') }, 1, timer)
  const stop = notifier.start()
  await drain()
  await timer.advance(59000)
  assert.deepEqual(calls, [0])
  await timer.advance(1000)
  assert.deepEqual(calls, [0, 60000])
  stop()
  assert.equal(timer.pending, 0)
})
