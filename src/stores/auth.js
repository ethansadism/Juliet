import { defineStore } from 'pinia'
import { api, apiEnabled, getToken, setToken } from '../lib/api.js'

const USER_KEY = 'juliet:auth:user'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null, // { username, displayName, role }
    hydrated: false,
  }),
  getters: {
    isAdmin: (s) => s.user?.role === 'admin',
  },
  actions: {
    hydrate() {
      if (this.hydrated) return
      this.hydrated = true
      if (!getToken()) {
        this.user = null
        return
      }
      try {
        const raw = localStorage.getItem(USER_KEY)
        if (raw) this.user = JSON.parse(raw)
      } catch {
        this.user = null
      }
    },
    async login(username, password) {
      if (!apiEnabled()) {
        throw new Error('登入後端未設定 (VITE_SYNC_URL)')
      }
      const data = await api.login(username, password)
      setToken(data.token)
      this.user = {
        username: data.username,
        displayName: data.displayName || data.username,
        role: data.role || 'user',
      }
      localStorage.setItem(USER_KEY, JSON.stringify(this.user))
    },
    async changePassword(oldPassword, newPassword) {
      await api.changePassword(oldPassword, newPassword)
    },
    logout() {
      this.user = null
      setToken(null)
      localStorage.removeItem(USER_KEY)
    },
  },
})
