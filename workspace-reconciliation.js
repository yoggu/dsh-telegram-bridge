// Runs only in the Web Host, which alone owns the workspace registry and JSON storage.
// The headless Telegram Host never opens that registry: two writers would lose updates.
export const name = 'external-session-workspace-reconciliation'
export const inject = ['workspaceRegistry', 'sessionPersistence']

export async function reconcileWorkspaceSessions(ctx, { workspacePath, agentPreset }) {
  const workspace = await ctx.workspaceRegistry.resolveByPath(workspacePath)
  if (!workspace) throw new Error('Configured workspace does not exist')
  const snapshots = await ctx.sessionPersistence.list()
  let attached = 0
  for (const { header } of snapshots) {
    if (header.cwd !== workspace.path || header.agentPreset !== agentPreset ||
        header.origin === 'subagent' || header.parentSession !== undefined ||
        workspace.sessionIds.includes(header.id)) continue
    if (ctx.workspaceRegistry.list().some(other => other.id !== workspace.id && other.sessionIds.includes(header.id))) continue
    await workspace.attachSession(header.id)
    attached++
  }
  return attached
}

export function apply(ctx, config = {}) {
  if (typeof config.workspacePath !== 'string' || !config.workspacePath.startsWith('/') ||
      typeof config.agentPreset !== 'string' || !config.agentPreset) throw new Error('Workspace reconciliation requires an absolute workspacePath and agentPreset')
  const intervalMs = config.intervalMs ?? 15000
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10000) throw new Error('Workspace reconciliation interval must be at least 10 seconds')
  let busy = null
  let running = true
  const scan = () => {
    if (!running || busy) return
    busy = reconcileWorkspaceSessions(ctx, config)
      .then(count => { if (count) ctx.logger.info(`Grouped ${count} external agent sessions`) })
      .catch(() => ctx.logger.warn('External session workspace reconciliation failed; will retry'))
      .finally(() => { busy = null })
  }
  const timer = setInterval(scan, intervalMs)
  timer.unref()
  scan()
  ctx.effect(() => async () => {
    running = false
    clearInterval(timer)
    if (busy) await busy
  }, 'external session workspace reconciliation')
}
