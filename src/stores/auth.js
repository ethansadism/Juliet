import { defineStore } from 'pinia'

// Placeholder accounts. Edit src/users.js to manage the real list.
import { USERS } from '../users.js'

const STORAGE_KEY = 'juliet:auth:user'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    hydrated: false,
  }),
  actions: {
    hydrate() {
      if (this.hydrated) return
      this.hydrated = true
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw) this.user = JSON.parse(raw)
      } catch {
        this.user = null
      }
    },
    login(username, password) {
      const u = USERS.find(
        (x) => x.username === username.trim() && x.password === password,
      )
      if (!u) return false
      this.user = { username: u.username, displayName: u.displayName ?? u.username }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.user))
      return true
    },
    logout() {
      this.user = null
      localStorage.removeItem(STORAGE_KEY)
    },
  },
})
