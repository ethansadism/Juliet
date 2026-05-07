<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'
import { useProgressStore } from '../stores/progress.js'
import { withSync } from '../lib/sync.js'

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
  try {
    await auth.login(username.value.trim(), password.value)
    progress.hydrate()
    await withSync(() => progress.pullAndMerge())
    router.replace({ name: 'home' })
  } catch (err) {
    if (err.code === 'invalid credentials') {
      error.value = '帳號或密碼不正確'
    } else if (err.message?.includes('VITE_SYNC_URL')) {
      error.value = '登入後端未設定,請聯絡管理員'
    } else {
      error.value = err.message || String(err)
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <div class="topbar">
      <h1>月月 模擬考</h1>
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
      <p class="muted" style="margin-top: 12px; font-size: 13px">
        忘記密碼請洽管理員重設。
      </p>
    </div>
  </div>
</template>
