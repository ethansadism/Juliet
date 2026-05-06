import { defineStore } from 'pinia'
import { isCorrect } from '../lib/parseQuestion.js'
import { useAuthStore } from './auth.js'
import { syncEnabled, syncProgress, pushExam, pullAll } from '../lib/sync.js'

const VERSION = 2

const defaultSettings = () => ({
  questionsPerExam: 250,
  errorBarPercent: 0,
  skipKnown: false,
})

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

function migrateLocalV1(data) {
  // v1 had questionStats[qid].knownByUser; flatten into a knownIds list.
  if (data.version === VERSION) return data
  const knownIds = Array.isArray(data.knownIds) ? data.knownIds.slice() : []
  if (data.questionStats) {
    for (const [qid, s] of Object.entries(data.questionStats)) {
      if (s && s.knownByUser && !knownIds.includes(qid)) knownIds.push(qid)
    }
  }
  return { ...data, version: VERSION, knownIds }
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
    wrongQuestionIds(state) {
      const known = new Set(state.knownIds)
      const out = []
      for (const [qid, s] of Object.entries(state.questionStats)) {
        if (s.timesWrong > 0 && !known.has(qid)) out.push(qid)
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
      data = migrateLocalV1(data)
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
            settings: { ...defaultSettings(), ...(remoteProgress.settings || {}) },
            knownIds: Array.isArray(remoteProgress.knownIds) ? remoteProgress.knownIds : [],
            activeExam: remoteProgress.activeExam || null,
            lastActivityAt: remoteProgress.lastActivityAt,
          }
          progressChanged = true
        }
      }

      if (!examsChanged && !progressChanged) {
        // Still push any local-only finished exams so an earlier offline
        // submit catches up.
        const remoteIds = new Set(remoteExams.map((e) => e.id))
        for (const ex of this.exams) {
          if (ex.finishedAt && !remoteIds.has(ex.id)) {
            pushExam(auth.user.username, ex)
          }
        }
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
      // Push any local-only finished exams (e.g. submitted while offline).
      const remoteIds = new Set(remoteExams.map((e) => e.id))
      for (const ex of this.exams) {
        if (ex.finishedAt && !remoteIds.has(ex.id)) {
          pushExam(auth.user.username, ex)
        }
      }
      return true
    },
    updateSettings(partial) {
      this.settings = { ...this.settings, ...partial }
      this._persist()
    },

    // ----- exam lifecycle -----
    startExam(allQuestionIds) {
      const settings = this.settings
      const knownSet = new Set(this.knownIds)
      let pool = allQuestionIds
      if (settings.skipKnown) pool = pool.filter((id) => !knownSet.has(id))

      const wrongPool = pool.filter((id) => {
        const s = this.questionStats[id]
        return s && s.timesWrong > 0 && !knownSet.has(id)
      })
      const wrongSet = new Set(wrongPool)
      const freshPool = pool.filter((id) => !wrongSet.has(id))

      const target = Math.min(settings.questionsPerExam, pool.length)
      const m = Math.min(
        wrongPool.length,
        Math.round((settings.errorBarPercent / 100) * wrongPool.length),
      )
      const wrongPicks = pickRandom(wrongPool, m)
      const remaining = Math.max(0, target - wrongPicks.length)
      let freshPicks = pickByLeastSeen(freshPool, this.questionStats, remaining)
      if (freshPicks.length < remaining) {
        const used = new Set(wrongPicks)
        const extra = pickRandom(
          wrongPool.filter((id) => !used.has(id)),
          remaining - freshPicks.length,
        )
        freshPicks = freshPicks.concat(extra)
      }
      const order = shuffle([...wrongPicks, ...freshPicks])

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
    submitActive() {
      if (!this.activeExam) return null
      const ex = this.activeExam
      ex.finishedAt = new Date().toISOString()
      this.exams.push(ex)
      this.activeExam = null
      this.lastActivityAt = ex.finishedAt
      this.questionStats = deriveStats(this.exams)
      this._persist()
      // Push the finished exam immediately (no debounce) so it can never
      // be erased by a later progress-only push from a stale device.
      const auth = useAuthStore()
      if (auth.user) pushExam(auth.user.username, ex)
      return ex
    },
    async cancelActive() {
      // Refresh first so we don't clobber a snapshot newer than ours.
      await this.pullAndMerge()
      if (!this.activeExam) return
      this.activeExam = null
      this.lastActivityAt = new Date().toISOString()
      this._persist()
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
