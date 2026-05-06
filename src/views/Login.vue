<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'
import { useProgressStore } from '../stores/progress.js'
import { pullSnapshot, syncEnabled } from '../lib/sync.js'

const router = useRouter()
const auth = useAuthStore()
const progress = useProgressStore()

const username = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  error.value = ''
  if (!username.value || !password.value) {
    error.value = '請輸入帳號與密碼'
    return
  }
  busy.value = true
  const ok = auth.login(username.value, password.value)
  if (!ok) {
    error.value = '帳號或密碼不正確'
    busy.value = false
    return
  }
  // Try cloud pull (only overrides local if local is empty/older)
  if (syncEnabled()) {
    try {
      const remote = await pullSnapshot(auth.user.username)
      if (remote) {
        const localRaw = localStorage.getItem(`juliet:progress:${auth.user.username}`)
        const localTs = localRaw ? JSON.parse(localRaw).lastActivityAt : null
        if (!localTs || (remote.lastActivityAt && remote.lastActivityAt > localTs)) {
          localStorage.setItem(
            `juliet:progress:${auth.user.username}`,
            JSON.stringify(remote),
          )
        }
      }
    } catch {
      // ignore — offline ok
    }
  }
  progress.hydrate()
  busy.value = false
  router.replace({ name: 'home' })
}
</script>

<template>
  <div>
    <div class="topbar">
      <h1>Juliet 模擬考</h1>
    </div>
    <div class="card">
      <h2>登入</h2>
      <form @submit.prevent="submit">
        <input
          class="input"
          v-model="username"
          autocomplete="username"
          placeholder="帳號"
          autocapitalize="none"
          autocorrect="off"
        />
        <div class="spacer" />
        <input
          class="input"
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="密碼"
        />
        <p v-if="error" class="error" style="margin-top: 10px">{{ error }}</p>
        <button class="btn primary" type="submit" :disabled="busy">
          {{ busy ? '登入中…' : '登入' }}
        </button>
      </form>
      <p class="muted" style="margin-top: 12px">
        目前為佔位帳號:user1 / 1234, demo / demo
      </p>
    </div>
  </div>
</template>
