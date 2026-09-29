// Private-chat command menu: Telegram does not derive this from message handling.
export const germanCommandMenu = Object.freeze([
  Object.freeze({ command: 'start', description: 'Hilfe und verfügbare Befehle' }),
  Object.freeze({ command: 'help', description: 'Hilfe anzeigen' }),
  Object.freeze({ command: 'status', description: 'Sitzung und Modell anzeigen' }),
  Object.freeze({ command: 'new', description: 'Neue Sitzung erstellen' }),
  Object.freeze({ command: 'compact', description: 'Gesprächsverlauf verdichten' }),
  Object.freeze({ command: 'stop', description: 'Laufende Antwort abbrechen' })
])

export const commandMenu = Object.freeze([
  Object.freeze({ command: 'start', description: 'Help and available commands' }),
  Object.freeze({ command: 'help', description: 'Show help' }),
  Object.freeze({ command: 'status', description: 'Show session and model' }),
  Object.freeze({ command: 'new', description: 'Create a new session' }),
  Object.freeze({ command: 'compact', description: 'Compact conversation history' }),
  Object.freeze({ command: 'stop', description: 'Cancel the running response' })
])

export function formatStatus({ hasSession, active, model, language = 'en' }) {
  if (language === 'de') {
    if (!hasSession) return `DSH: Noch keine Sitzung.\nModell: ${model}`
    return `DSH: Sitzung ${active ? 'arbeitet' : 'bereit'}.\nModell: ${model}`
  }
  if (!hasSession) return `DSH: No session yet.\nModel: ${model}`
  return `DSH: Session ${active ? 'working' : 'ready'}.\nModel: ${model}`
}

export async function syncPrivateCommands(api, userId, language = 'en') {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Private chat ID required for command menu')
  await api('setMyCommands', { commands: language === 'de' ? germanCommandMenu : commandMenu, scope: { type: 'chat', chat_id: userId } })
}
