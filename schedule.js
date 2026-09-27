export function createSchedule(jobs = [], timeZone = 'UTC') {
  if (!Array.isArray(jobs)) throw new Error('Telegram jobs must be an array')
  const ids = new Set()
  for (const job of jobs) {
    if (!job || !/^[a-z0-9][a-z0-9-]*$/.test(job.id) || ids.has(job.id) ||
        typeof job.label !== 'string' || !job.label || typeof job.prompt !== 'string' || !job.prompt ||
        !Number.isInteger(job.hour) || job.hour < 0 || job.hour > 23 ||
        !Number.isInteger(job.minute) || job.minute < 0 || job.minute > 59 ||
        (job.weekday && !['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(job.weekday)) ||
        !['read-only', 'workspace-write'].includes(job.permissionPreset)) throw new Error('Invalid Telegram scheduled job')
    ids.add(job.id)
  }
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  })
  const localParts = ms => Object.fromEntries(formatter.formatToParts(new Date(ms)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]))
  const nextRun = (job, now = Date.now()) => {
    let target = Math.floor(now / 60000) * 60000 + 60000
    const limit = target + 8 * 86400000
    for (; target <= limit; target += 60000) {
      const p = localParts(target)
      if (+p.hour === job.hour && +p.minute === job.minute && (!job.weekday || p.weekday === job.weekday)) return target
    }
    throw new Error('No scheduled occurrence within eight days')
  }
  const slotKey = (job, ms) => {
    const p = localParts(ms)
    return `${job.id}:${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
  }
  return { jobs, localParts, nextRun, slotKey }
}
