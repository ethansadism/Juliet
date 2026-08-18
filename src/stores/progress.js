import { defineStore } from 'pinia'
import { isCorrect } from '../lib/parseQuestion.js'
import { useAuthStore } from './auth.js'
import {
  syncEnabled,
  syncProgress,
  pushExam,
  pullAll,
  withSync,
  setPendingUploads,
} from '../lib/sync.js'

const VERSION = 4

const defaultSettings = () => ({
  questionsPerExam: 250,
  errorCount: 0, // forced wrong-answer questions, as a count
  knownCount: 0, // forced "我會了" review questions, as a count
})

function clampCount(v, max) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(max, n))
}

function pctToCount(pct, examSize) {
  const n = Number(pct)
  if (!Number.isFinite(n)) return 0
  return Math.round((Math.max(0, Math.min(100, n)) / 100) * examSize)
}

function normalizeSettings(raw) {
  const s = { ...defaultSettings(), ...(raw || {}) }
  const n = Math.round(Number(s.questionsPerExam))
  s.questionsPerExam = Number.isFinite(n) && n > 0 ? n : 250

  // v2 → v3: the "略過我會了" switch became a bar; both switch positions
  // map to zero, since a question marked 我會了 now only re-enters an exam
  // when explicitly asked for.
  // v3 → v4: the bars hold a question count instead of a percentage. A
  // percentage could not address single questions in a small exam — 17%
  // and 20% of a 5-question exam are both "1 question", so dragging did
  // nothing until it suddenly jumped.
  if (raw && raw.errorCount === undefined && raw.errorBarPercent !== undefined) {
    s.errorCount = pctToCount(raw.errorBarPercent, s.questionsPerExam)
  }
  if (raw && raw.knownCount === undefined && raw.knownBarPercent !== undefined) {
    s.knownCount = pctToCount(raw.knownBarPercent, s.questionsPerExam)
  }
  delete s.skipKnown
  delete s.errorBarPercent
  delete s.knownBarPercent

  s.errorCount = clampCount(s.errorCount, s.questionsPerExam)
  s.knownCount = clampCount(s.knownCount, s.questionsPerExam)
  // The two forced groups share one exam, so they cannot outgrow it.
  if (s.errorCount + s.knownCount > s.questionsPerExam) {
    s.knownCount = Math.max(0, s.questionsPerExam - s.errorCount)
  }
  return s
}

const emptyState = () => ({
  version: VERSION,
  settings: defaultSettings(),
  knownIds: [], // qids the user marked "我會了"
  exams: [], // local cache of finished exams; cloud lives in _exams sheet
  activeExam: null,
  lastActivityAt: null,
  // questionStats is a derived cache (not persisted to cloud).
  // Recomputed from `exams` on hydrate / pullAndMerge / submit.
  questionStats: {},
})

function storageKey(username) {
  return `juliet:progress:${username}`
}

function shuffle(arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function pickRandom(pool, n) {
  if (n <= 0) return []
  if (n >= pool.length) return shuffle(pool)
  return shuffle(pool).slice(0, n)
}

function pickByLeastSeen(ids, stats, n) {
  if (n <= 0) return []
  const buckets = new Map()
  for (const id of ids) {
    const t = stats[id]?.timesAnswered ?? 0
    if (!buckets.has(t)) buckets.set(t, [])
    buckets.get(t).push(id)
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b)
  const out = []
  for (const k of keys) {
    if (out.length >= n) break
    out.push(...pickRandom(buckets.get(k), n - out.length))
  }
  return out
}

// Rebuild per-question counters from the immutable exam history.
function deriveStats(exams) {
  const stats = {}
  for (const ex of exams) {
    if (!ex || !ex.finishedAt) continue
    for (const [qid, a] of Object.entries(ex.answers || {})) {
      if (!stats[qid]) {
        stats[qid] = {
          timesAnswered: 0,
          timesCorrect: 0,
          timesWrong: 0,
          lastWrong: false,
          lastAnsweredAt: null,
        }
      }
      const s = stats[qid]
      s.timesAnswered++
      if (a.correct) {
        s.timesCorrect++
        s.lastWrong = false
      } else {
        s.timesWrong++
        s.lastWrong = true
      }
      if (!s.lastAnsweredAt || (a.ts && a.ts > s.lastAnsweredAt)) {
        s.lastAnsweredAt = a.ts || null
      }
    }
  }
  return stats
}

function migrateLocal(data) {
  // v1 had questionStats[qid].knownByUser; flatten into a knownIds list.
  const knownIds = Array.isArray(data.knownIds) ? data.knownIds.slice() : []
  if (data.questionStats) {
    for (const [qid, s] of Object.entries(data.questionStats)) {
      if (s && s.knownByUser && !knownIds.includes(qid)) knownIds.push(qid)
    }
  }
  // v2 had settings.skipKnown; normalizeSettings folds it away.
  return {
    ...data,
    version: VERSION,
    knownIds,
    settings: normalizeSettings(data.settings),
  }
}

// --- legacy question-id migration -------------------------------------
// Ids used to be a position in the whole workbook; they are now a row
// number within one worksheet. Records written under the old scheme are
// translated on the way in, so history, the error pool and 我會了 marks
// all survive the change. `map` is empty once every stored record has
// been rewritten, at which point this is all a no-op.

function remapExam(ex, map) {
  if (!ex) return { exam: ex, changed: false }
  let changed = false
  const questionIds = (ex.questionIds || []).map((qid) => {
    const next = map.get(qid)
    if (next) changed = true
    return next || qid
  })
  const answers = {}
  for (const [qid, a] of Object.entries(ex.answers || {})) {
    const next = map.get(qid)
    if (next) changed = true
    answers[next || qid] = a
  }
  if (!changed) return { exam: ex, changed: false }
  return { exam: { ...ex, questionIds, answers }, changed: true }
}

function unionExamsById(localExams, remoteExams) {
  const byId = new Map()
  for (const e of localExams) if (e && e.id) byId.set(e.id, e)
  for (const re of remoteExams || []) {
    if (!re || !re.id) continue
    const local = byId.get(re.id)
    if (!local) {
      byId.set(re.id, re)
      continue
    }
    // Prefer the one with finishedAt set, or the later one.
    const winner =
      re.finishedAt && (!local.finishedAt || re.finishedAt > local.finishedAt)
        ? re
        : local
    byId.set(re.id, winner)
  }
  return [...byId.values()].sort((a, b) =>
    (a.startedAt || '') < (b.startedAt || '') ? -1 : 1,
  )
}

export const useProgressStore = defineStore('progress', {
  state: () => emptyState(),
  getters: {
    answeredQuestionCount(state) {
      return Object.values(state.questionStats).filter((s) => s.timesAnswered > 0)
        .length
    },
    totalAttempts(state) {
      return Object.values(state.questionStats).reduce(
        (sum, s) => sum + s.timesAnswered,
        0,
      )
    },
    totalCorrect(state) {
      return Object.values(state.questionStats).reduce(
        (sum, s) => sum + s.timesCorrect,
        0,
      )
    },
    correctRate(state) {
      const a = Object.values(state.questionStats).reduce(
        (sum, s) => sum + s.timesAnswered,
        0,
      )
      const c = Object.values(state.questionStats).reduce(
        (sum, s) => sum + s.timesCorrect,
        0,
      )
      return a === 0 ? 0 : c / a
    },
    knownSet(state) {
      return new Set(state.knownIds)
    },
    // Questions still owed a correction: wrong on the most recent attempt.
    // Using "ever wrong" instead made this set grow without bound — one
    // user reached 335 entries, so even a 6% error-bar filled their whole
    // exam with repeats.
    wrongQuestionIds(state) {
      const known = new Set(state.knownIds)
      const out = []
      for (const [qid, s] of Object.entries(state.questionStats)) {
        if (s.lastWrong && !known.has(qid)) out.push(qid)
      }
      return out
    },
    knownQuestionIds(state) {
      return state.knownIds.slice()
    },
    avgSecondsPer100(state) {
      let totalSeconds = 0
      let totalAnswered = 0
      for (const ex of state.exams) {
        if (!ex.finishedAt) continue
        const dur = (new Date(ex.finishedAt) - new Date(ex.startedAt)) / 1000
        const answered = Object.keys(ex.answers ?? {}).length
        if (dur > 0 && answered > 0) {
          totalSeconds += dur
          totalAnswered += answered
        }
      }
      return totalAnswered === 0 ? 0 : (totalSeconds / totalAnswered) * 100
    },
  },
  actions: {
    _snapshot() {
      // What we push to the cloud _progress cell — no exams, no derived stats.
      return {
        version: VERSION,
        settings: this.settings,
        knownIds: this.knownIds,
        activeExam: this.activeExam,
        lastActivityAt: this.lastActivityAt,
      }
    },
    _persist() {
      const auth = useAuthStore()
      if (!auth.user) return
      // Local copy includes exams + cached stats so reload works offline.
      const fullLocal = {
        ...this._snapshot(),
        exams: this.exams,
      }
      try {
        localStorage.setItem(storageKey(auth.user.username), JSON.stringify(fullLocal))
      } catch (err) {
        console.warn('localStorage write failed', err)
      }
      syncProgress(auth.user.username, this._snapshot()).catch((err) =>
        console.warn('cloud sync failed', err),
      )
    },
    hydrate() {
      const auth = useAuthStore()
      if (!auth.user) {
        Object.assign(this, emptyState())
        return
      }
      const raw = localStorage.getItem(storageKey(auth.user.username))
      if (!raw) {
        Object.assign(this, emptyState())
        return
      }
      let data
      try {
        data = JSON.parse(raw)
      } catch {
        Object.assign(this, emptyState())
        return
      }
      data = migrateLocal(data)
      const next = { ...emptyState(), ...data }
      next.exams = Array.isArray(next.exams) ? next.exams : []
      next.knownIds = Array.isArray(next.knownIds) ? next.knownIds : []
      next.questionStats = deriveStats(next.exams)
      Object.assign(this, next)
    },
    async pullAndMerge() {
      const auth = useAuthStore()
      if (!auth.user || !syncEnabled()) return false
      const remote = await pullAll(auth.user.username)
      if (!remote) return false
      const remoteProgress = remote.progress
      const remoteExams = remote.exams || []

      // Exams: union by id (append-only semantics).
      const mergedExams = unionExamsById(this.exams, remoteExams)
      const examsChanged = mergedExams.length !== this.exams.length

      // Progress (settings/active/known/lastActivity): adopt only if
      // remote is strictly newer than local.
      let progressChanged = false
      let next = {
        settings: this.settings,
        knownIds: this.knownIds,
        activeExam: this.activeExam,
        lastActivityAt: this.lastActivityAt,
      }
      if (remoteProgress && remoteProgress.lastActivityAt) {
        if (
          !this.lastActivityAt ||
          remoteProgress.lastActivityAt > this.lastActivityAt
        ) {
          next = {
            settings: normalizeSettings(remoteProgress.settings),
            knownIds: Array.isArray(remoteProgress.knownIds) ? remoteProgress.knownIds : [],
            activeExam: remoteProgress.activeExam || null,
            lastActivityAt: remoteProgress.lastActivityAt,
          }
          progressChanged = true
        }
      }

      if (!examsChanged && !progressChanged) {
        await this._pushMissingExams(auth.user.username, remoteExams)
        return false
      }

      this.$patch((state) => {
        state.exams = mergedExams
        state.settings = next.settings
        state.knownIds = next.knownIds
        state.activeExam = next.activeExam
        state.lastActivityAt = next.lastActivityAt
        state.questionStats = deriveStats(mergedExams)
      })
      // Persist merged view to localStorage; do NOT push back to cloud
      // unless we changed something the cloud doesn't have.
      try {
        const fullLocal = { ...this._snapshot(), exams: this.exams }
        localStorage.setItem(storageKey(auth.user.username), JSON.stringify(fullLocal))
      } catch (err) {
        console.warn('localStorage write failed', err)
      }
      await this._pushMissingExams(auth.user.username, remoteExams)
      return true
    },
    // Replay exams the cloud is missing (submitted while offline, or while
    // the session was silently unauthorized). Sequential on purpose: one
    // recovery run replayed 52 exams at once, which is a burst Apps Script
    // has no reason to absorb and which interleaves writes to one sheet.
    async _pushMissingExams(username, remoteExams) {
      const remoteIds = new Set((remoteExams || []).map((e) => e.id))
      const missing = this.exams.filter((ex) => ex.finishedAt && !remoteIds.has(ex.id))
      setPendingUploads(missing.length)
      for (let i = 0; i < missing.length; i++) {
        const ok = await pushExam(username, missing[i])
        // Stop on the first failure and leave the remaining count on the
        // banner; the next pull retries. Pressing on is how 52 queued
        // exams turn into 52 identical errors.
        if (!ok) return
        setPendingUploads(missing.length - i - 1)
      }
    },
    // Called once the question bank is loaded, and again after each pull,
    // since remote records may still carry old ids. Rewritten exams are
    // pushed back so the cloud converges on the new ids instead of every
    // client translating forever — the translation table is only accurate
    // while the worksheets' row structure matches the build it came from.
    async applyLegacyMap(map) {
      if (!map || map.size === 0) return false
      const auth = useAuthStore()
      const migrated = []
      const exams = this.exams.map((ex) => {
        const { exam, changed } = remapExam(ex, map)
        if (changed) migrated.push(exam)
        return exam
      })
      const knownIds = this.knownIds.map((qid) => map.get(qid) || qid)
      const { exam: activeExam } = remapExam(this.activeExam, map)
      const knownChanged = knownIds.some((qid, i) => qid !== this.knownIds[i])
      const activeChanged = activeExam !== this.activeExam
      if (!migrated.length && !knownChanged && !activeChanged) return false

      this.$patch((state) => {
        state.exams = exams
        state.knownIds = knownIds
        state.activeExam = activeExam
        state.questionStats = deriveStats(exams)
      })
      this._persist() // also pushes the rewritten knownIds / activeExam
      if (!auth.user) return true
      setPendingUploads(migrated.length)
      for (let i = 0; i < migrated.length; i++) {
        const ok = await pushExam(auth.user.username, migrated[i])
        if (!ok) break // retried on the next load
        setPendingUploads(migrated.length - i - 1)
      }
      return true
    },
    updateSettings(partial) {
      this.settings = normalizeSettings({ ...this.settings, ...partial })
      this._persist()
    },

    // ----- exam lifecycle -----
    startExam(allQuestionIds) {
      const settings = this.settings
      const knownSet = new Set(this.knownIds)

      // Three disjoint pools. A question marked 我會了 only ever enters an
      // exam through knownCount — at 0 it is skipped entirely, which
      // is what the old skipKnown switch did when it was on.
      const knownPool = allQuestionIds.filter((id) => knownSet.has(id))
      const rest = allQuestionIds.filter((id) => !knownSet.has(id))
      const wrongPool = rest.filter((id) => {
        const s = this.questionStats[id]
        return s && s.lastWrong
      })
      const wrongSet = new Set(wrongPool)
      const freshPool = rest.filter((id) => !wrongSet.has(id))

      // Both quotas are plain question counts. Expressing them as a share
      // of their own pool made the numbers swing wildly as the pools grew:
      // against a 335-question error pool, "21%" meant 70 questions — more
      // than three times a 20-question exam.
      const nominal = settings.questionsPerExam
      let wrongPicks = pickRandom(wrongPool, Math.min(wrongPool.length, settings.errorCount))
      let knownPicks = pickRandom(knownPool, Math.min(knownPool.length, settings.knownCount))

      const target = Math.min(nominal, rest.length + knownPicks.length)
      // The settings screen caps both sliders so their quotas fit inside the
      // exam, but settings can also arrive from another device or predate a
      // pool that has since shrunk. Trim proportionally instead of
      // overflowing the requested question count.
      const forced = wrongPicks.length + knownPicks.length
      if (forced > target) {
        const keepWrong = Math.round((wrongPicks.length / forced) * target)
        wrongPicks = wrongPicks.slice(0, keepWrong)
        knownPicks = knownPicks.slice(0, target - wrongPicks.length)
      }

      const remaining = Math.max(0, target - wrongPicks.length - knownPicks.length)
      let freshPicks = pickByLeastSeen(freshPool, this.questionStats, remaining)
      if (freshPicks.length < remaining) {
        const used = new Set(wrongPicks)
        const extra = pickRandom(
          wrongPool.filter((id) => !used.has(id)),
          remaining - freshPicks.length,
        )
        freshPicks = freshPicks.concat(extra)
      }
      const order = shuffle([...wrongPicks, ...knownPicks, ...freshPicks])

      const exam = {
        id: `exam-${Date.now()}`,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        settings: { ...settings },
        questionIds: order,
        answers: {},
        currentIndex: 0,
        wrongIncluded: wrongPicks.length,
        wrongPoolSize: wrongPool.length,
      }
      this.activeExam = exam
      this.lastActivityAt = exam.startedAt
      this._persist()
      return exam
    },
    setActiveIndex(i) {
      if (!this.activeExam) return
      this.activeExam.currentIndex = i
      this._persist()
    },
    answerActive(qid, selectedLetter, correctAnswer) {
      if (!this.activeExam) return
      const correct = isCorrect(correctAnswer, selectedLetter)
      this.activeExam.answers[qid] = {
        selected: selectedLetter,
        correct,
        ts: new Date().toISOString(),
      }
      this.lastActivityAt = this.activeExam.answers[qid].ts
      this._persist()
    },
    async submitActive() {
      if (!this.activeExam) return null
      return withSync(async () => {
        const ex = this.activeExam
        ex.finishedAt = new Date().toISOString()
        this.exams.push(ex)
        this.activeExam = null
        this.lastActivityAt = ex.finishedAt
        this.questionStats = deriveStats(this.exams)
        this._persist()
        // Push the finished exam immediately (no debounce) so it can never
        // be erased by a later progress-only push from a stale device.
        // Awaited so the syncing overlay covers the whole round-trip.
        const auth = useAuthStore()
        if (auth.user) await pushExam(auth.user.username, ex)
        return ex
      })
    },
    async cancelActive() {
      return withSync(async () => {
        // Refresh first so we don't clobber a snapshot newer than ours.
        await this.pullAndMerge()
        if (!this.activeExam) return
        this.activeExam = null
        this.lastActivityAt = new Date().toISOString()
        this._persist()
      })
    },
    setKnown(qid, known) {
      const set = new Set(this.knownIds)
      if (known) set.add(qid)
      else set.delete(qid)
      this.knownIds = [...set]
      this.lastActivityAt = new Date().toISOString()
      this._persist()
    },
    getExam(examId) {
      return this.exams.find((e) => e.id === examId) ?? null
    },
  },
})
