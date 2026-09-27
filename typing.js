// Telegram displays chat actions for about five seconds. Never block a real
// answer on this cosmetic, best-effort side channel.
export function createTypingNotifier(api, chatId, options = {}) {
  const schedule = options.schedule || setTimeout
  const clear = options.clear || clearTimeout
  const now = options.now || Date.now
  const intervalMs = options.intervalMs || 4000
  let nextAllowedAt = 0
  let disposed = false
  let currentStop = null

  function start() {
    if (disposed || currentStop) return currentStop || (() => {})
    let running = true
    let timer
    let request
    const stop = () => {
      if (!running) return
      running = false
      if (timer) clear(timer)
      request?.abort()
      if (currentStop === stop) currentStop = null
    }
    currentStop = stop
    async function tick() {
      if (!running) return
      const remaining = nextAllowedAt - now()
      if (remaining > 0) {
        timer = schedule(tick, remaining)
        return
      }
      request = new AbortController()
      try {
        await api('sendChatAction', { chat_id: chatId, action: 'typing' }, request.signal)
      } catch (error) {
        if (running) nextAllowedAt = now() + (String(error?.message).includes('HTTP 429') ? 60000 : 10000)
      } finally {
        request = null
        if (running) timer = schedule(tick, Math.max(intervalMs, nextAllowedAt - now()))
      }
    }
    void tick()
    return stop
  }
  function dispose() { disposed = true; currentStop?.() }
  return { start, dispose }
}
