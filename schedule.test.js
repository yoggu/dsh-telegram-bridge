import test from 'node:test'
import assert from 'node:assert/strict'
import { createSchedule } from './schedule.js'

const jobs = [
  { id: 'daily', label: 'Daily', hour: 7, minute: 0, prompt: '/daily', permissionPreset: 'read-only' },
  { id: 'weekly', label: 'Weekly', hour: 17, minute: 0, weekday: 'Thu', prompt: '/weekly', permissionPreset: 'workspace-write' }
]
const schedule = createSchedule(jobs, 'Europe/Zurich')
test('a configured daily job stays at 07:00 Zurich through DST', () => {
  for (const iso of ['2026-03-28T20:00:00Z', '2026-03-29T20:00:00Z', '2026-10-24T20:00:00Z', '2026-10-25T20:00:00Z']) {
    const p = schedule.localParts(schedule.nextRun(jobs[0], Date.parse(iso)))
    assert.equal(p.hour, '07')
    assert.equal(p.minute, '00')
  }
})
test('a configured weekly job runs Thursday and one slot is unique', () => {
  const at = schedule.nextRun(jobs[1], Date.parse('2026-09-23T20:00:00Z'))
  assert.equal(schedule.localParts(at).weekday, 'Thu')
  assert.equal(schedule.localParts(at).hour, '17')
  assert.equal(schedule.slotKey(jobs[1], at), schedule.slotKey(jobs[1], at + 1000))
})
test('schedule rejects duplicate ids and invalid permissions', () => {
  assert.throws(() => createSchedule([jobs[0], jobs[0]], 'UTC'), /Invalid Telegram scheduled job/)
  assert.throws(() => createSchedule([{ ...jobs[0], permissionPreset: 'danger-full-access' }], 'UTC'), /Invalid Telegram scheduled job/)
})
