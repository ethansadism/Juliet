<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'
import { api } from '../lib/api.js'

const router = useRouter()
const auth = useAuthStore()

const users = ref([])
const loading = ref(false)
const error = ref('')

const newUsername = ref('')
const newDisplayName = ref('')
const newPassword = ref('')
const newRole = ref('user')
const formBusy = ref(false)
const formMsg = ref('')

const myOldPw = ref('')
const myNewPw = ref('')
const myMsg = ref('')

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    const data = await api.adminListUsers()
    users.value = data.users || []
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

onMounted(refresh)

async function resetPassword(u) {
  const pw = prompt(`輸入「${u.username}」的新密碼:`)
  if (!pw) return
  if (pw.length < 4) {
    alert('密碼至少 4 個字元')
    return
  }
  try {
    await api.adminUpsertUser({
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      password: pw,
    })
    alert(`已重設「${u.username}」的密碼`)
    refresh()
  } catch (err) {
    alert('失敗:' + err.message)
  }
}

async function deleteUser(u) {
  if (u.username === auth.user.username) {
    alert('不能刪除自己')
    return
  }
  if (!confirm(`確定刪除「${u.username}」?其進度資料也會被清除。`)) return
  try {
    await api.adminDeleteUser(u.username)
    refresh()
  } catch (err) {
    alert('失敗:' + err.message)
  }
}

async function toggleRole(u) {
  const next = u.role === 'admin' ? 'user' : 'admin'
  if (!confirm(`將「${u.username}」改為 ${next}?`)) return
  try {
    await api.adminUpsertUser({
      username: u.username,
      displayName: u.displayName,
      role: next,
    })
    refresh()
  } catch (err) {
    alert('失敗:' + err.message)
  }
}

async function createUser() {
  formMsg.value = ''
  if (!newUsername.value || !newPassword.value) {
    formMsg.value = '請輸入帳號與密碼'
    return
  }
  formBusy.value = true
  try {
    await api.adminUpsertUser({
      username: newUsername.value.trim(),
      displayName: newDisplayName.value.trim() || newUsername.value.trim(),
      password: newPassword.value,
      role: newRole.value,
    })
    formMsg.value = `✓ 已建立「${newUsername.value}」`
    newUsername.value = ''
    newDisplayName.value = ''
    newPassword.value = ''
    newRole.value = 'user'
    refresh()
  } catch (err) {
    formMsg.value = '失敗:' + err.message
  } finally {
    formBusy.value = false
  }
}

async function changeMyPassword() {
  myMsg.value = ''
  if (!myOldPw.value || !myNewPw.value) return
  if (myNewPw.value.length < 4) {
    myMsg.value = '密碼至少 4 個字元'
    return
  }
  try {
    await auth.changePassword(myOldPw.value, myNewPw.value)
    myMsg.value = '✓ 已更新'
    myOldPw.value = ''
    myNewPw.value = ''
  } catch (err) {
    myMsg.value = '失敗:' + err.message
  }
}
</script>

<template>
  <div>
    <div class="topbar">
      <button class="btn ghost" style="width: auto; padding: 6px 10px; margin: 0" @click="router.back()">
        ←
      </button>
      <h1>管理</h1>
      <span />
    </div>

    <div class="card">
      <h2>修改我的密碼</h2>
      <input class="input" type="password" v-model="myOldPw" placeholder="舊密碼" />
      <div class="spacer" />
      <input class="input" type="password" v-model="myNewPw" placeholder="新密碼" />
      <p v-if="myMsg" class="muted" style="margin-top: 8px">{{ myMsg }}</p>
      <button class="btn" @click="changeMyPassword">更新密碼</button>
    </div>

    <div class="card">
      <h2>新增使用者</h2>
      <input class="input" v-model="newUsername" placeholder="帳號" autocapitalize="none" />
      <div class="spacer" />
      <input class="input" v-model="newDisplayName" placeholder="顯示名稱(可選)" />
      <div class="spacer" />
      <input class="input" v-model="newPassword" type="password" placeholder="初始密碼" />
      <div class="spacer" />
      <div class="row">
        <label>角色</label>
        <select class="input" v-model="newRole" style="max-width: 140px">
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
      </div>
      <p v-if="formMsg" class="muted" style="margin-top: 8px">{{ formMsg }}</p>
      <button class="btn primary" :disabled="formBusy" @click="createUser">
        {{ formBusy ? '建立中…' : '建立' }}
      </button>
    </div>

    <div class="card">
      <h2>使用者列表</h2>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-else-if="loading" class="muted">載入中…</p>
      <div v-else>
        <div v-for="u in users" :key="u.username" class="review-item">
          <div class="row">
            <div>
              <strong>{{ u.username }}</strong>
              <span v-if="u.role === 'admin'" class="badge good">admin</span>
              <div class="muted" style="font-size: 13px">{{ u.displayName }}</div>
            </div>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-top: 8px">
            <button class="btn ghost" style="margin: 0; font-size: 14px; padding: 8px" @click="resetPassword(u)">
              重設密碼
            </button>
            <button class="btn ghost" style="margin: 0; font-size: 14px; padding: 8px" @click="toggleRole(u)">
              {{ u.role === 'admin' ? '降為 user' : '升為 admin' }}
            </button>
            <button
              class="btn danger"
              style="margin: 0; font-size: 14px; padding: 8px"
              :disabled="u.username === auth.user.username"
              @click="deleteUser(u)"
            >
              刪除
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
