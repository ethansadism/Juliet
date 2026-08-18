// Cross-device progress sync. localStorage is the source of truth for the
// running session; the cloud copy is split into two pieces:
//   _progress sheet : settings + knownIds + activeExam + lastActivityAt
//   _exams sheet    : append-only, one row per submitted exam
//
// progress is debounced; exams are pushed immediately on submit so a
// completed exam can never be wiped by a stale-device snapshot push.
//
// Every failure here used to be swallowed into a console.warn. That is how
// one account went 78 days with a dead session while the app looked
// perfectly healthy, its progress accumulating in localStorage only. The
// reactive `syncStatus` below exists so failures reach the screen.

import { reactive, ref } from 'vue'
import { api, apiEnabled } from './api.js'

export const syncStatus = reactive({
  expired: false, // server rejected our token
  failing: false, // last call failed for some other reason (offline, quota)
  pending: 0, // finished exams known to be missing from the cloud
  lastError: '',
})

export function setPendingUploads(n) {
  syncStatus.pending = Math.max(0, n)
}

function noteOk() {
  syncStatus.expired = false
  syncStatus.failing = false
  syncStatus.lastError = ''
}

function noteError(err) {
  if (err && err.code === 'unauthorized') {
    syncStatus.expired = true
  } else {
    syncStatus.failing = true
  }
  syncStatus.lastError = (err && err.message) || String(err)
}

// Counter incremented while a user-initiated sync is in flight, so the
// App-level overlay can block input during it.
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
    noteOk()
  } catch (err) {
    noteError(err)
    console.warn('progress push failed', err.message)
  }
}

export async function pushExam(username, exam) {
  if (!syncEnabled()) return false
  try {
    await api.putExam(username, exam)
    noteOk()
    return true
  } catch (err) {
    noteError(err)
    console.warn('exam push failed', err.message)
    return false
  }
}

export async function pullAll(username) {
  if (!syncEnabled()) return null
  try {
    const data = await api.getAll(username)
    noteOk()
    return {
      progress: data?.progress ?? null,
      exams: data?.exams ?? [],
    }
  } catch (err) {
    noteError(err)
    console.warn('pullAll failed', err.message)
    return null
  }
}
