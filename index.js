import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { loadCredentials, loadState, loadScheduleState, saveState, telegramApi, sendText, chunks, withDeadline, restrictModel, confineAgent, authorized, acquirePollerLock, validateBridgeConfig } from './core.js'
import { createSchedule } from './schedule.js'
import { createHeadlessSessions } from './headless-session.js'
import { createTypingNotifier } from './typing.js'
import { formatStatus, syncPrivateCommands } from './commands.js'

export { Config } from './config.js'
export const name = 'dsh-telegram-bridge'
export const inject = ['agents', 'sessions', 'sessionQuery', 'sessionPersistence', 'agentPresets', 'permissionPresets']

/** Host-only Cordis plugin. Telegram updates are never trusted to select a DSH session or filesystem path. */
export function apply(ctx, config = {}) {
  const paths = validateBridgeConfig(config)
  // Host-only locale: explicit German opt-in; unset/unknown languages use English.
  const t = (de, en) => config.language === 'de' ? de : en
  const { jobs, nextRun, slotKey } = createSchedule(config.jobs || [], config.timeZone || 'UTC')
  const headless = createHeadlessSessions(ctx, config)
  let running = true
  let controller = new AbortController()
  let ownedSessionId = null
  let state
  let api
  let userId
  let typing
  let stopTyping
  let pending = null
  let pollPromise
  let releaseLock
  let scheduleState
  let scheduleWrites = Promise.resolve()
  const timers = new Map()
  let retryTimer
  const retrying = new Set()
  const scheduledPending = new Map()
  let active = false
  let serialized = Promise.resolve()
  let stateWrites = Promise.resolve()
  const inflight = new Set()
  function updateState(change) {
    stateWrites = stateWrites.then(async () => {
      const next = { ...state, ...change }
      await saveState(paths.state, next)
      state = next
    })
    return stateWrites
  }

  // Host-wide guard: defaults and picker catalogs do not prevent a restored session
  // or an auxiliary model call from selecting a different provider.
  ctx.on('llm/stream', (options, next) => restrictModel(options, next, config.provider, config.model), { global: true, prepend: true })
  // The workspace-write root is the session's cwd, not the process cwd.
  ctx.on('agent/created', ({ agent }) => confineAgent(agent, config.cwd, ctx.permissionPresets), { global: true })

  // This adapter owns only the session it creates/adopts from its private state file.
  ctx.on('approval/request', async (request, next) => {
    if (request.agent.session.id !== ownedSessionId && !jobs.some(job => scheduleState?.jobs[job.id]?.sessionId === request.agent.session.id)) return next()
    // Do not grant based on Telegram callbacks. Sensitive tool actions fail closed.
    return 'rejected'
  })
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (agent.session.id === ownedSessionId && pending && message.source?.rpcId === pending.requestId) pending.turn = turn
    const scheduled = scheduledPending.get(agent.session.id)
    if (scheduled && message.source?.rpcId === scheduled.requestId) scheduled.turn = turn
  })
  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    if (agent.session.id === ownedSessionId && pending && message.source?.rpcId === pending.requestId) {
      const target = pending
      pending = null
      target.resolve({ text: t('DSH: Anfrage verworfen.', 'DSH: Request discarded.'), success: false })
    }
    const scheduled = scheduledPending.get(agent.session.id)
    if (scheduled && message.source?.rpcId === scheduled.requestId) {
      scheduledPending.delete(agent.session.id)
      scheduled.resolve({ text: t('DSH: geplante Anfrage verworfen.', 'DSH: Scheduled request discarded.'), success: false })
    }
  })
  ctx.on('session/event', (session, event) => {
    const target = session.id === ownedSessionId ? pending : scheduledPending.get(session.id)
    if (!target || target.turn === undefined) return
    if (event.type === 'assistant/message' && event.data.turn === target.turn && !event.data.interrupted) {
      const text = event.data.message?.content?.filter(block => block.type === 'text').map(block => block.text).join('')
      if (text?.trim()) target.answer = text
    }
    if (event.type === 'turn/end' && event.data.turn === target.turn) {
      if (target === pending) pending = null
      else scheduledPending.delete(session.id)
      target.resolve({ text: target.answer || t(`DSH: turn ${event.data.reason.kind}; keine Textantwort.`, `DSH: turn ${event.data.reason.kind}; no text response.`), success: event.data.reason.kind === 'completed' && Boolean(target.answer?.trim()) })
    }
  })

  async function session() {
    if (ownedSessionId) return ownedSessionId
    const agent = await headless.acquire(state.sessionId, config.permissionPreset, id => updateState({ sessionId: id }))
    ownedSessionId = agent.session.id
    return ownedSessionId
  }

  async function prompt(text) {
    const sessionId = await session()
    const requestId = randomUUID()
    const result = new Promise(resolve => { pending = { resolve, requestId, answer: '' } })
    try {
      headless.prompt(sessionId, text, requestId)
      stopTyping = typing.start()
      return await withDeadline(result, 20 * 60 * 1000, { text: t('DSH: Zeitlimit erreicht. Die Sitzung kann noch laufen; bitte keine riskante Anfrage blind wiederholen.', 'DSH: Time limit reached. The session may still be running; do not blindly repeat a risky request.'), success: false })
    } finally {
      stopTyping?.()
      stopTyping = null
      pending = null
    }
  }

  async function handle(update) {
    if (!authorized(update, userId)) return
    const message = update.message
    if (update.callback_query) {
      await api('answerCallbackQuery', { callback_query_id: update.callback_query.id, text: t('Nicht unterstützt.', 'Not supported.') })
      return
    }
    const text = message?.text?.trim()
    if (typeof text === 'string' && text.length > 16000) {
      await sendText(api, userId, t('Nachricht zu lang (maximal 16 000 Zeichen).', 'Message too long (maximum 16,000 characters).'))
      return
    }
    if (!text) {
      await sendText(api, userId, t('Derzeit nur Textnachrichten unterstützt.', 'Only text messages are currently supported.'))
      return
    }
    const command = text.split(/\s/, 1)[0].toLowerCase().split('@')[0]
    if (command === '/help' || command === '/start') {
      await sendText(api, userId, t('DSH Telegram: Textnachrichten; /status Sitzung und Modell, /new neue Sitzung, /compact Gespräch verdichten, /stop Antwort abbrechen. Anhänge und Freigaben per Telegram sind nicht verfügbar.', 'DSH Telegram: Send text messages; /status session and model, /new new session, /compact compact conversation, /stop cancel response. Attachments and approvals via Telegram are unavailable.'))
      return
    }
    if (command === '/status') {
      if (text.split(/\s+/).length !== 1) { await sendText(api, userId, t('Verwendung: /status', 'Usage: /status')); return }
      const status = headless.status(ownedSessionId)
      await sendText(api, userId, formatStatus({ hasSession: Boolean(state.sessionId), active: Boolean(pending) || status === 'running' || Boolean(scheduledPending.size), model: config.model, language: config.language }))
      return
    }
    if (command === '/stop') {
      if (ownedSessionId) { headless.cancel(ownedSessionId); stopTyping?.() }
      else if (active) { await sendText(api, userId, t('Sitzung wird noch erstellt; Stopp derzeit nicht möglich.', 'The session is still being created; stopping is not yet possible.')); return }
      await sendText(api, userId, t('Stopp angefordert.', 'Stop requested.'))
      return
    }
    if (command === '/new') {
      if (text.split(/\s+/).length !== 1) { await sendText(api, userId, t('Verwendung: /new', 'Usage: /new')); return }
      await updateState({ sessionId: null })
      ownedSessionId = null
      await session()
      await sendText(api, userId, t('Neue Sitzung erstellt. Die nächste Nachricht beginnt das Gespräch.', 'New session created. The next message starts the conversation.'))
      return
    }
    if (command === '/compact') {
      if (text.split(/\s+/).length !== 1) { await sendText(api, userId, t('Verwendung: /compact', 'Usage: /compact')); return }
      if (!state.sessionId) { await sendText(api, userId, t('Noch keine Sitzung zum Verdichten vorhanden.', 'There is no session to compact yet.')); return }
      const sessionId = await session()
      try {
        const result = await headless.compact(sessionId, controller.signal)
        await sendText(api, userId, result === null
          ? t('Noch kein sinnvoll verdichtbarer Gesprächsverlauf.', 'There is no conversation history worth compacting yet.')
          : t(`Kontext verdichtet: ${result.shadowedSeqs.length} Einträge (~${result.shadowedTokenCount} Tokens).`, `Context compacted: ${result.shadowedSeqs.length} entries (~${result.shadowedTokenCount} tokens).`))
      } catch (error) {
        const message = {
          busy: t('Sitzung beschäftigt; bitte nach der Antwort erneut versuchen.', 'Session busy; please try again after the response.'),
          cancelled: t('Verdichtung abgebrochen.', 'Compaction cancelled.'),
          changed: t('Verlauf hat sich während der Verdichtung geändert; bitte prüfen, nicht blind wiederholen.', 'History changed during compaction; please review it rather than blindly retrying.'),
          summary: t('Keine brauchbare Zusammenfassung erzeugt; bitte prüfen.', 'No usable summary was generated; please review.'),
          commit: t('Verdichtung nicht sauber abgeschlossen; Sitzungsverlauf vor erneutem Versuch prüfen.', 'Compaction did not finish cleanly; review the session history before retrying.'),
          persistence: t('Verdichtung abgeschlossen, konnte aber nicht gespeichert werden; bitte prüfen.', 'Compaction completed but could not be saved; please review.')
        }[error?.name === 'ManualCompactionError' ? error.code : '']
        if (!message) {
          ctx.logger.warn(`Telegram manual compaction unavailable: ${error?.name || 'Error'} / ${error?.code || 'unspecified'}`)
          await sendText(api, userId, t('Verdichtung fehlgeschlagen. Die Sitzung bleibt erhalten; bitte später erneut versuchen oder Dienstprotokoll prüfen.', 'Compaction failed. The session is preserved; try again later or check the service log.'))
        } else await sendText(api, userId, message)
      }
      return
    }
    if (command.startsWith('/') && command !== '/') {
      await sendText(api, userId, t('Unbekannter Befehl. /help', 'Unknown command. /help'))
      return
    }
    const result = await prompt(text)
    await sendText(api, userId, result.text)
  }

  function updateSchedule(jobId, change) {
    const write = scheduleWrites.then(async () => {
      const next = { jobs: { ...scheduleState.jobs, [jobId]: { ...scheduleState.jobs[jobId], ...change } } }
      await saveState(paths.schedule, next)
      scheduleState = next
    })
    scheduleWrites = write.catch(() => {}) // allow later safe status writes after an isolated I/O failure
    return write
  }

  async function scheduledSession(job) {
    const existing = scheduleState.jobs[job.id]?.sessionId
    const agent = await headless.acquire(existing, job.permissionPreset, id => updateSchedule(job.id, { sessionId: id }))
    return agent.session.id
  }

  async function deliverScheduled(job) {
    const record = scheduleState.jobs[job.id]
    if (!record?.outbox?.text || record.status === 'delivered') return
    const parts = chunks(`⏰ ${job.label}\n\n${record.outbox.text}`)
    for (let i = record.outbox.nextChunk || 0; i < parts.length; i++) {
      await api('sendMessage', { chat_id: userId, text: parts[i], disable_web_page_preview: true })
      await updateSchedule(job.id, { status: 'sending', outbox: { ...scheduleState.jobs[job.id].outbox, nextChunk: i + 1 } })
    }
    await updateSchedule(job.id, { status: 'delivered', outbox: null })
  }

  async function runScheduled(job, target) {
    if (!running || Date.now() - target > 120000) return
    const key = slotKey(job, target)
    if (scheduleState.jobs[job.id]?.outbox) {
      console.error('Scheduled job deferred: prior Telegram delivery pending:', job.id)
      return
    }
    if (scheduleState.jobs[job.id]?.slot === key) return
    // Mark slot before model work: a crash cannot trigger duplicate recipe-history writes.
    await updateSchedule(job.id, { slot: key, status: 'started', outbox: null })
    try {
      const sessionId = await scheduledSession(job)
      const requestId = randomUUID()
      const result = new Promise(resolve => scheduledPending.set(sessionId, { requestId, resolve, answer: '' }))
      try {
        headless.prompt(sessionId, job.prompt, requestId)
        const outcome = await withDeadline(result, 20 * 60 * 1000, { text: t('DSH: Zeitlimit der geplanten Aufgabe überschritten.', 'DSH: Scheduled task time limit exceeded.'), success: false })
        const text = outcome.success ? outcome.text : t(`Geplanter Lauf fehlgeschlagen. ${outcome.text}`, `Scheduled run failed. ${outcome.text}`)
        await updateSchedule(job.id, { status: 'generated', outbox: { text, nextChunk: 0 } })
        retrying.add(job.id)
        try { await deliverScheduled(job) } finally { retrying.delete(job.id) }
      } finally { scheduledPending.delete(sessionId) }
    } catch (error) {
      // Do not overwrite a generated outbox on a Telegram transport failure.
      if (!scheduleState.jobs[job.id]?.outbox) await updateSchedule(job.id, {
        status: 'generated', outbox: { text: t('Geplanter Lauf fehlgeschlagen. Bitte manuell prüfen; keine automatische Neuausführung.', 'Scheduled run failed. Please review manually; there will be no automatic rerun.'), nextChunk: 0 }
      })
      console.error('Scheduled job failed:', job.id, error?.name || 'Error', error?.code || 'unspecified')
    }
  }

  function arm(job) {
    if (!running) return
    const target = nextRun(job)
    const timer = setTimeout(() => {
      timers.delete(job.id)
      const work = runScheduled(job, target).catch(() => console.error('Scheduled state persistence failed:', job.id)).finally(() => arm(job))
      inflight.add(work)
      void work.finally(() => inflight.delete(work))
    }, Math.max(0, target - Date.now()))
    timers.set(job.id, timer)
    console.info('Telegram scheduled:', job.id, new Date(target).toISOString())
  }

  async function run() {
    const credentials = await loadCredentials(paths.credentials)
    userId = credentials.userId
    api = telegramApi(credentials.token)
    typing = createTypingNotifier(api, userId)
    state = await loadState(paths.state, credentials.offset)
    scheduleState = await loadScheduleState(paths.schedule)
    if (await realpath(config.cwd) !== config.cwd) throw new Error('Telegram workspace must be a canonical absolute path')
    if (config.permissionPreset !== 'workspace-write') throw new Error('Telegram permission preset is not safe')
    releaseLock = await acquirePollerLock(paths.lock)
    // No -1 offset trick or first-contact pairing. Reject all users other than the existing pinned ID.
    ctx.logger.info('Telegram bridge started (authorized private chat only)')
    try { await syncPrivateCommands(api, userId, config.language) }
    catch (error) { ctx.logger.warn(`Telegram private command menu could not be updated: ${error?.name || 'Error'}`) }
    if (config.enableSchedules === true) {
      for (const job of jobs) {
        arm(job)
        if (['started', 'failed'].includes(scheduleState.jobs[job.id]?.status) && !scheduleState.jobs[job.id]?.outbox) {
          await updateSchedule(job.id, { status: 'generated', outbox: { text: t('Geplanter Lauf fehlgeschlagen oder beim Neustart unterbrochen. Bitte manuell prüfen; keine automatische Neuausführung.', 'Scheduled run failed or was interrupted by a restart. Please review manually; there will be no automatic rerun.'), nextChunk: 0 } })
        }
      }
      retryTimer = setInterval(() => {
        for (const job of jobs) {
          if (!running || !scheduleState.jobs[job.id]?.outbox || retrying.has(job.id)) continue
          retrying.add(job.id)
          const retry = deliverScheduled(job).catch(() => console.error('Scheduled outbox retry failed:', job.id)).finally(() => retrying.delete(job.id))
          inflight.add(retry)
          void retry.finally(() => inflight.delete(retry))
        }
      }, 60000)
      retryTimer.unref()
      // Pending outbox items retry at the next minute; generation itself is never replayed.
    }
    while (running) {
      try {
        const updates = await api('getUpdates', { offset: state.offset, timeout: 25, limit: 20, allowed_updates: ['message', 'callback_query'] }, controller.signal)
        for (const update of updates) {
          if (!running) break
          if (!Number.isSafeInteger(update.update_id) || update.update_id < state.offset) continue
          // Acknowledge the update before any model work: never run one prompt twice after a crash.
          await updateState({ offset: update.update_id + 1 })
          if (!authorized(update, userId)) continue
          // Serialize all updates except /stop, which must interrupt a running model turn.
          const stop = /^\/stop(?:@\w+)?(?:\s|$)/i.test(update.message?.text || '')
          const report = error => console.error('Telegram update failed:', error?.name || 'Error', error?.code || 'unspecified')
          const work = (stop ? handle(update) : (serialized = serialized.then(async () => {
            active = true
            try { await handle(update) } finally { active = false }
          }).catch(report))).catch(report)
          inflight.add(work)
          void work.finally(() => inflight.delete(work))
        }
      } catch (error) {
        if (!running) break
        ctx.logger.warn('Telegram polling interrupted; retrying (details suppressed)')
        await new Promise(resolve => setTimeout(resolve, 3000))
      }
    }
  }

  pollPromise = run().catch(() => { ctx.logger.error('Telegram bridge stopped; credentials, workspace, or local state invalid') })
  ctx.effect(() => async () => {
    running = false
    controller.abort()
    typing?.dispose()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    if (retryTimer) clearInterval(retryTimer)
    for (const target of scheduledPending.values()) target.resolve({ text: t('DSH: Verbindung beendet.', 'DSH: Connection closed.'), success: false })
    scheduledPending.clear()
    if (pending) {
      const target = pending
      pending = null
      target.resolve({ text: t('DSH: Verbindung beendet.', 'DSH: Connection closed.'), success: false })
    }
    await pollPromise
    await Promise.race([Promise.allSettled([...inflight]), new Promise(resolve => setTimeout(resolve, 5000))])
    await headless.dispose()
    if (releaseLock) await releaseLock()
  }, 'telegram polling')
}
