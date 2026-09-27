import { randomUUID } from 'node:crypto'

// No Web SessionController, file-upload service, Connection or HTTP server.
export function createHeadlessSessions(ctx, config) {
  const handles = new Map()
  const creating = new Map()
  const selection = { provider: config.provider, model: config.model,
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}) }
  const setup = async agentCtx => { await ctx.agentPresets.mount(agentCtx, config.agentPreset) }
  async function inspect(id) {
    const live = ctx.agents.get(id)
    if (live) return { header: live.session.header, preset: ctx.agentPresets.composedPreset(live.ctx) }
    const observation = await ctx.sessionQuery.observeSession(id, { projectionMode: 'all' })
    try { return { header: observation.header, preset: observation.projections?.values.agentPreset } }
    finally { observation[Symbol.dispose]() }
  }
  function validate(record, id) {
    if (record.header.id !== id || record.header.cwd !== config.cwd || record.preset !== config.agentPreset ||
        record.header.origin === 'subagent' || record.header.parentSession !== undefined) {
      throw new Error('Telegram session identity mismatch')
    }
  }
  async function acquire(id, permissionPreset, saveId) {
    const key = id || 'new'
    if (creating.has(key)) return creating.get(key)
    const work = (async () => {
      const preset = await ctx.agentPresets.resolve(config.agentPreset)
      if (preset.broken) throw new Error('Telegram agent preset unavailable')
      if (id) {
        const owned = handles.get(id)
        if (owned && ctx.agents.get(id) === owned.agent) {
          ctx.permissionPresets.set(owned.agent.session, permissionPreset)
          return owned.agent
        }
        if (ctx.agents.get(id)) throw new Error('Telegram session owned by another Host component')
        validate(await inspect(id), id)
      }
      const sessionId = id || `telegram-${randomUUID()}`
      const handle = id
        ? await ctx.agents.resume({ resumeSessionId: id, agentOptions: selection, setup })
        : await ctx.agents.create({ sessionId, meta: { cwd: config.cwd, agentPreset: config.agentPreset }, agentOptions: selection, setup })
      try {
        validate({ header: handle.agent.session.header, preset: ctx.agentPresets.composedPreset(handle.agent.ctx) }, sessionId)
        ctx.permissionPresets.set(handle.agent.session, permissionPreset)
        if (!id) await saveId(sessionId)
        handles.set(sessionId, handle)
        return handle.agent
      } catch (error) { await handle.dispose(); throw error }
    })()
    creating.set(key, work)
    try { return await work } finally { creating.delete(key) }
  }
  function agent(id) {
    const owned = handles.get(id)
    if (!owned || ctx.agents.get(id) !== owned.agent) throw new Error('Telegram agent unavailable')
    return owned.agent
  }
  function prompt(id, text, rpcId) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Telegram prompt must be nonempty')
    const content = Object.freeze([Object.freeze({ type: 'text', text })])
    const source = Object.freeze({ kind: 'user', rpcId, clientTimeZone: config.timeZone || 'UTC' })
    agent(id).followup(Object.freeze({ id: randomUUID(), role: 'user', content, source }))
  }
  function cancel(id) { if (id && handles.has(id) && ctx.agents.get(id) === handles.get(id).agent) agent(id).cancel({ kind: 'user' }, { keepInbox: true }) }
  function status(id) {
    const owned = id && handles.get(id)
    return owned && ctx.agents.get(id) === owned.agent ? owned.agent.status : null
  }
  function compact(id, signal) {
    const owned = agent(id)
    const compaction = ctx.agentPresets.serviceFor(owned, 'compaction')
    if (!compaction) throw new Error('Compaction is not available in the Telegram agent preset')
    return compaction.compactNow(owned, signal)
  }
  async function dispose() { await Promise.allSettled([...handles.values()].map(handle => handle.dispose())) }
  return { acquire, prompt, cancel, status, compact, dispose }
}
