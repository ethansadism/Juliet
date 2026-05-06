// Optional cross-device sync via Google Apps Script web app.
// Set VITE_SYNC_URL at build time to enable. See apps-script/Code.gs for
// the matching backend.
//
// localStorage is the source of truth. The cloud copy is a snapshot
// pushed after each mutation; we last-writer-wins on pull.

const SYNC_URL = import.meta.env.VITE_SYNC_URL

let pushTimer = null
let lastPayload = null

export function syncEnabled() {
  return typeof SYNC_URL === 'string' && SYNC_URL.length > 0
}

export async function syncProgress(username, snapshot) {
  if (!syncEnabled()) return
  lastPayload = { username, snapshot }
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(flush, 1500)
}

async function flush() {
  if (!lastPayload) return
  const { username, snapshot } = lastPayload
  lastPayload = null
  pushTimer = null
  try {
    await fetch(SYNC_URL, {
      method: 'POST',
      // Apps Script web apps tolerate text/plain to avoid CORS preflight
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ op: 'put', username, snapshot }),
    })
  } catch (err) {
    console.warn('sync push failed', err)
  }
}

export async function pullSnapshot(username) {
  if (!syncEnabled()) return null
  try {
    const url = `${SYNC_URL}?op=get&username=${encodeURIComponent(username)}`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    return data?.snapshot ?? null
  } catch (err) {
    console.warn('sync pull failed', err)
    return null
  }
}
