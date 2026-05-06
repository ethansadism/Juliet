// Cross-device progress sync. localStorage is the source of truth;
// the cloud copy is a snapshot pushed (debounced) after each mutation.

import { api, apiEnabled } from './api.js'

let pushTimer = null
let pending = null

export function syncEnabled() {
  return apiEnabled()
}

export async function syncProgress(username, snapshot) {
  if (!syncEnabled()) return
  pending = { username, snapshot }
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(flush, 1500)
}

async function flush() {
  const job = pending
  pending = null
  pushTimer = null
  if (!job) return
  try {
    await api.putProgress(job.username, job.snapshot)
  } catch (err) {
    console.warn('progress push failed', err.message)
  }
}

export async function pullSnapshot(username) {
  if (!syncEnabled()) return null
  try {
    const data = await api.getProgress(username)
    return data?.snapshot ?? null
  } catch (err) {
    console.warn('progress pull failed', err.message)
    return null
  }
}
