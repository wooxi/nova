import type { LayeredSettings, Settings } from './types'

export async function fetchSettings(): Promise<LayeredSettings> {
  const r = await fetch('/api/settings')
  if (!r.ok) throw new Error(`fetch settings ${r.status}`)
  return r.json()
}

export async function updateUserSettings(s: Settings): Promise<LayeredSettings> {
  const r = await fetch('/api/settings/user', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s),
  })
  if (!r.ok) throw new Error(`update user settings ${r.status}`)
  return r.json()
}

export async function updateWorkspaceSettings(s: Settings): Promise<LayeredSettings> {
  const r = await fetch('/api/settings/workspace', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s),
  })
  if (!r.ok) throw new Error(`update workspace settings ${r.status}`)
  return r.json()
}
