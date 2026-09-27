import { readFile, rename, open, lstat, unlink } from 'node:fs/promises'
import { createServer, createConnection } from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const MAX_MESSAGE = 3900

export function validateBridgeConfig(config) {
  if (!config || typeof config !== 'object' || typeof config.cwd !== 'string' || !isAbsolute(config.cwd) ||
      typeof config.dataDir !== 'string' || !isAbsolute(config.dataDir) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(config.agentPreset || '') ||
      !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(config.provider || '') ||
      typeof config.model !== 'string' || !config.model ||
      config.permissionPreset !== 'workspace-write' ||
      (config.timeZone !== undefined && typeof config.timeZone !== 'string')) throw new Error('Invalid Telegram bridge configuration')
  // No secret or pinned Telegram ID is accepted from the public DSH configuration.
  return {
    credentials: join(config.dataDir, 'credentials.json'),
    state: join(config.dataDir, 'dsh-state.json'),
    schedule: join(config.dataDir, 'dsh-schedule.json'),
    lock: join(config.dataDir, 'dsh-poller.sock')
  }
}

// Kernel-backed exclusivity without stale PID files. Socket cleanup is safe only for this process.
export async function acquirePollerLock(path) {
  if (typeof path !== 'string' || !path) throw new Error('Telegram lock path required')
  const server = createServer()
  const listen = () => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => { server.removeListener('error', reject); resolve() })
  })
  try { await listen() } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error
    const alive = await new Promise(resolve => {
      const peer = createConnection(path)
      peer.once('connect', () => { peer.destroy(); resolve(true) })
      peer.once('error', () => { peer.destroy(); resolve(false) })
    })
    if (alive) throw new Error('Telegram poller already active')
    // A crashed owner leaves a stale socket. Only remove an actual socket in our private dir.
    const info = await lstat(path)
    if (!info.isSocket()) throw new Error('Telegram poller lock path is not a socket')
    await unlink(path)
    await listen()
  }
  return async () => {
    await new Promise(resolve => server.close(resolve))
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

export async function loadCredentials(path) {
  const folder = await lstat(dirname(path))
  if (!folder.isDirectory() || (folder.mode & 0o077)) throw new Error('Telegram data directory must be private (0700)')
  const info = await lstat(path)
  if (!info.isFile() || (info.mode & 0o077)) throw new Error('Telegram credentials must be a private regular file (0600)')
  const data = JSON.parse(await readFile(path, 'utf8'))
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(data.botToken) || !Number.isSafeInteger(data.allowedUserId) || data.allowedUserId <= 0) {
    throw new Error('Telegram token or pre-authorized user ID missing')
  }
  return { token: data.botToken, userId: data.allowedUserId, offset: Number.isSafeInteger(data.lastUpdateId) ? data.lastUpdateId + 1 : 0 }
}

export function authorized(update, userId) {
  const message = update?.message
  const callback = update?.callback_query
  if (message) return message.chat?.type === 'private' && message.chat?.id === userId && message.from?.id === userId && !message.from?.is_bot
  if (callback) return callback.message?.chat?.type === 'private' && callback.message.chat.id === userId && callback.from?.id === userId && !callback.from?.is_bot
  return false
}

export function chunks(text, max = MAX_MESSAGE) {
  const result = []
  let part = ''
  for (const point of String(text)) {
    if (part.length + point.length > max) { result.push(part); part = '' }
    part += point
  }
  if (part) result.push(part)
  return result
}

export async function saveState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`)
    await handle.sync()
  } finally { await handle.close() }
  try { await rename(temporary, path) } catch (error) { throw error }
  const dir = await open(dirname(path), 'r')
  try { await dir.sync() } finally { await dir.close() }
}

export async function loadState(path, legacyOffset) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || (info.mode & 0o077)) throw new Error('Telegram state must be a private regular file (0600)')
    const state = JSON.parse(await readFile(path, 'utf8'))
    if (!Number.isSafeInteger(state.offset) || state.offset < 0 ||
        (state.sessionId !== null && typeof state.sessionId !== 'string')) throw new Error('Invalid Telegram adapter state')
    return state
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { offset: legacyOffset, sessionId: null }
  }
}

export async function loadScheduleState(path) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || (info.mode & 0o077)) throw new Error('Telegram schedule state must be a private regular file (0600)')
    const state = JSON.parse(await readFile(path, 'utf8'))
    if (!state || typeof state !== 'object' || !state.jobs || typeof state.jobs !== 'object') throw new Error('Invalid schedule state')
    return state
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { jobs: {} }
  }
}

export function restrictModel(options, next, provider, model) {
  if (options.provider !== provider || options.model !== model) {
    throw new Error('TELEGRAM_MODEL_RESTRICTED: only the configured model is allowed')
  }
  return next()
}

export function confineAgent(agent, cwd, permissions) {
  if (agent.session.header.cwd !== cwd) throw new Error('TELEGRAM_WORKSPACE_RESTRICTED: session outside the configured working folder')
  permissions.set(agent.session, 'workspace-write')
}

export async function withDeadline(promise, ms, fallback) {
  let timer
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms) })]) }
  finally { clearTimeout(timer) }
}

export function telegramApi(token, fetchImpl = fetch) {
  return async (method, payload = {}, signal) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), method === 'getUpdates' ? 40000 : 15000)
    const abort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal
      })
      // Never surface Telegram's response body, request URL, or a raw fetch error: all may include the token.
      if (!response.ok) throw new Error(`Telegram ${method} HTTP ${response.status}`)
      const data = await response.json()
      if (!data.ok) throw new Error(`Telegram ${method} returned an error`)
      return data.result
    } catch (error) {
      if (signal?.aborted) throw new Error('Telegram request cancelled')
      if (error.message?.startsWith(`Telegram ${method}`)) throw error
      throw new Error(`Telegram ${method} failed`)
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }
}

export async function sendText(api, chatId, text) {
  for (const part of chunks(text)) await api('sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true })
}
