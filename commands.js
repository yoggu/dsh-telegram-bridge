// Private-chat command menu: Telegram does not derive this from message handling.
export const commandMenu = Object.freeze([
  Object.freeze({ command: 'start', description: 'Hilfe und verfügbare Befehle' }),
  Object.freeze({ command: 'help', description: 'Hilfe anzeigen' }),
  Object.freeze({ command: 'status', description: 'Sitzung und Modell anzeigen' }),
  Object.freeze({ command: 'new', description: 'Neue Sitzung erstellen' }),
  Object.freeze({ command: 'compact', description: 'Gesprächsverlauf verdichten' }),
  Object.freeze({ command: 'stop', description: 'Laufende Antwort abbrechen' })
])

export function formatStatus({ hasSession, active, model }) {
  if (!hasSession) return `DSH: Noch keine Sitzung.\nModell: ${model}`
  return `DSH: Sitzung ${active ? 'arbeitet' : 'bereit'}.\nModell: ${model}`
}

export async function syncPrivateCommands(api, userId) {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Private chat ID required for command menu')
  await api('setMyCommands', { commands: commandMenu, scope: { type: 'chat', chat_id: userId } })
}
