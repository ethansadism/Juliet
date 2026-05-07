// Cross-device progress sync. localStorage is the source of truth for the
// running session; the cloud copy is split into two pieces:
//   _progress sheet : settings + knownIds + activeExam + lastActivityAt
//   _exams sheet    : append-only, one row per submitted exam
//
// progress is debounced; exams are pushed immediately on submit so a
// completed exam can never be wiped by a stale-device snapshot push.

import { ref } from 'vue'
import { api, apiEnabled } from './api.js'

// Reactive counter incremented while a user-initiated sync is in flight
// (login pull, exam submit, discard, manual refresh). The App-level
// overlay watches this and blocks pointer input so a finger landing on
// "submit" the moment after it was tapped can't double-fire.
export const syncingCount = ref(0)

export async function withSync(fn) {
  syncingCount.value++
  try {
    return await fn()
  } finally {
    syncingCount.value--
  }
}

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

export async function pushExam(username, exam) {
  if (!syncEnabled()) return
  try {
    await api.putExam(username, exam)
  } catch (err) {
    console.warn('exam push failed', err.message)
  }
}

export async function pullAll(username) {
  if (!syncEnabled()) return null
  try {
    const data = await api.getAll(username)
    return {
      progress: data?.progress ?? null,
      exams: data?.exams ?? [],
    }
  } catch (err) {
    console.warn('pullAll failed', err.message)
    return null
  }
}
