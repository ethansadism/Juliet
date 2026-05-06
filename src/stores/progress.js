import { defineStore } from 'pinia'
import { isCorrect } from '../lib/parseQuestion.js'
import { useAuthStore } from './auth.js'
import { syncProgress } from '../lib/sync.js'

const VERSION = 1

const defaultSettings = () => ({
  questionsPerExam: 250,
  errorBarPercent: 0,
  skipKnown: false,
})

const emptyState = () => ({
  version: VERSION,
  settings: defaultSettings(),
  // qid -> { timesAnswered, timesCorrect, timesWrong, lastWrong, knownByUser, lastAnsweredAt }
  questionStats: {},
  // ordered exam history
  exams: [],
  // active (unfinished) exam, or null
  activeExam: null,
  lastActivityAt: null,
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

// Stratified pick: prefer questions seen the fewest times. This way, until
// every question has been answered at least once, no never-seen question is
// passed over in favour of a repeat.
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

function ensureStat(stats, qid) {
  if (!stats[qid]) {
    stats[qid] = {
      timesAnswered: 0,
      timesCorrect: 0,
      timesWrong: 0,
      lastWrong: false,
      knownByUser: false,
      lastAnsweredAt: null,
    }
  }
  return stats[qid]
}

export const useProgressStore = defineStore('progress', {
  state: () => emptyState(),
  getters: {
    answeredQuestionCount(state) {
      return Object.values(state.questionStats).filter((s) => s.timesAnswered > 0).length
    },
    totalAttempts(state) {
      return Object.values(state.questionStats).reduce((sum, s) => sum + s.timesAnswered, 0)
    },
    totalCorrect(state) {
      return Object.values(state.questionStats).reduce((sum, s) => sum + s.timesCorrect, 0)
    },
    correctRate(state) {
      const a = Object.values(state.questionStats).reduce((sum, s) => sum + s.timesAnswered, 0)
      const c = Object.values(state.questionStats).reduce((sum, s) => sum + s.timesCorrect, 0)
      return a === 0 ? 0 : c / a
    },
    wrongQuestionIds(state) {
      // currently-wrong = at least one wrong attempt and not marked known by user
      const out = []
      for (const [qid, s] of Object.entries(state.questionStats)) {
        if (s.timesWrong > 0 && !s.knownByUser) out.push(qid)
      }
      return out
    },
    knownQuestionIds(state) {
      const out = []
      for (const [qid, s] of Object.entries(state.questionStats)) {
        if (s.knownByUser) out.push(qid)
      }
      return out
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
    _persist() {
      const auth = useAuthStore()
      if (!auth.user) return
      const snapshot = {
        version: this.version,
        settings: this.settings,
        questionStats: this.questionStats,
        exams: this.exams,
        activeExam: this.activeExam,
        lastActivityAt: this.lastActivityAt,
      }
      try {
        localStorage.setItem(storageKey(auth.user.username), JSON.stringify(snapshot))
      } catch (err) {
        console.warn('localStorage write failed', err)
      }
      // best-effort cloud sync
      syncProgress(auth.user.username, snapshot).catch((err) =>
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
      try {
        const data = JSON.parse(raw)
        Object.assign(this, emptyState(), data)
        if (!this.settings) this.settings = defaultSettings()
      } catch {
        Object.assign(this, emptyState())
      }
    },
    updateSettings(partial) {
      this.settings = { ...this.settings, ...partial }
      this._persist()
    },

    // ----- exam lifecycle -----
    startExam(allQuestionIds) {
      const settings = this.settings
      const knownSet = new Set(this.knownQuestionIds)
      let pool = allQuestionIds
      if (settings.skipKnown) pool = pool.filter((id) => !knownSet.has(id))

      const wrongPool = pool.filter((id) => {
        const s = this.questionStats[id]
        return s && s.timesWrong > 0 && !s.knownByUser
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
      // Stratified by timesAnswered: never-seen first, then seen once, etc.
      let freshPicks = pickByLeastSeen(freshPool, this.questionStats, remaining)
      // if fresh pool too small, top up from unused wrong pool
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
        answers: {}, // qid -> { selected, correct, ts }
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
      // fold answers into questionStats
      for (const [qid, a] of Object.entries(ex.answers)) {
        const s = ensureStat(this.questionStats, qid)
        s.timesAnswered += 1
        if (a.correct) {
          s.timesCorrect += 1
          s.lastWrong = false
        } else {
          s.timesWrong += 1
          s.lastWrong = true
        }
        s.lastAnsweredAt = a.ts
      }
      this.exams.push(ex)
      this.activeExam = null
      this.lastActivityAt = ex.finishedAt
      this._persist()
      return ex
    },
    cancelActive() {
      this.activeExam = null
      this._persist()
    },
    // ----- per-question flags -----
    setKnown(qid, known) {
      const s = ensureStat(this.questionStats, qid)
      s.knownByUser = !!known
      this._persist()
    },
    // ----- review helpers -----
    getExam(examId) {
      return this.exams.find((e) => e.id === examId) ?? null
    },
  },
})
