import { defineStore } from 'pinia'
import { parseQuestion } from '../lib/parseQuestion.js'

export const useQuestionsStore = defineStore('questions', {
  state: () => ({
    loaded: false,
    loading: false,
    error: null,
    questions: [], // { id, sheet, gid, prompt, options, answer }
    sheets: [],
    fetchedAt: null,
  }),
  getters: {
    total: (s) => s.questions.length,
    byId: (s) => {
      const m = new Map()
      for (const q of s.questions) m.set(q.id, q)
      return m
    },
    // old id -> current id, for records written before ids became
    // per-worksheet row numbers. Empty once the build stops emitting
    // legacyId.
    legacyMap: (s) => {
      const m = new Map()
      for (const q of s.questions) {
        if (q.legacyId && q.legacyId !== q.id) m.set(q.legacyId, q.id)
      }
      return m
    },
  },
  actions: {
    async load() {
      if (this.loaded || this.loading) return
      this.loading = true
      this.error = null
      try {
        const url = `${import.meta.env.BASE_URL}data/questions.json`
        const res = await fetch(url, { cache: 'no-cache' })
        if (!res.ok) throw new Error(`Failed to load questions: ${res.status}`)
        const data = await res.json()
        this.sheets = data.sheets ?? []
        this.fetchedAt = data.fetchedAt ?? null
        this.questions = (data.questions ?? []).map((q) => {
          const parsed = parseQuestion(q.prompt)
          return {
            id: q.id,
            legacyId: q.legacyId,
            sheet: q.sheet,
            gid: q.gid,
            prompt: parsed.prompt || q.prompt,
            options: parsed.options,
            rawPrompt: q.prompt,
            answer: q.answer,
          }
        })
        this.loaded = true
      } catch (err) {
        this.error = err.message ?? String(err)
      } finally {
        this.loading = false
      }
    },
  },
})
