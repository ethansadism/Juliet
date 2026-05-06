// Thin client around the Apps Script web app. SYNC_URL was the original
// env var name (kept for compatibility) — it is now the auth+sync endpoint.

const API_URL = import.meta.env.VITE_SYNC_URL

const TOKEN_KEY = 'juliet:auth:token'

export function apiEnabled() {
  return typeof API_URL === 'string' && API_URL.length > 0
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || null
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

async function post(op, body = {}) {
  if (!apiEnabled()) throw new Error('API not configured (VITE_SYNC_URL)')
  const token = getToken()
  // text/plain avoids the CORS preflight Apps Script can't answer.
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ op, token, ...body }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (data.error) {
    const err = new Error(data.error)
    err.code = data.error
    throw err
  }
  return data
}

async function get(op, params = {}) {
  if (!apiEnabled()) throw new Error('API not configured (VITE_SYNC_URL)')
  const token = getToken()
  const qs = new URLSearchParams({ op, ...(token ? { token } : {}), ...params })
  const res = await fetch(`${API_URL}?${qs}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (data.error) {
    const err = new Error(data.error)
    err.code = data.error
    throw err
  }
  return data
}

export const api = {
  login: (username, password) => post('login', { username, password }),
  changePassword: (oldPassword, newPassword) =>
    post('changePassword', { oldPassword, newPassword }),
  getProgress: (username) => get('get', username ? { username } : {}),
  putProgress: (username, snapshot) => post('put', { username, snapshot }),
  adminListUsers: () => post('adminListUsers'),
  adminUpsertUser: (payload) => post('adminUpsertUser', payload),
  adminDeleteUser: (username) => post('adminDeleteUser', { username }),
}
