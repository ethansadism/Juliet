<script setup>
import { computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from './stores/auth.js'
import { useProgressStore } from './stores/progress.js'
import { syncingCount, syncStatus } from './lib/sync.js'

const router = useRouter()
const auth = useAuthStore()
const progress = useProgressStore()

const syncing = computed(() => syncingCount.value > 0)
const showBanner = computed(
  () => !!auth.user && (syncStatus.expired || syncStatus.failing || syncStatus.pending > 0),
)

function onVisible() {
  if (document.visibilityState !== 'visible') return
  if (!auth.user) return
  // Silent re-pull on focus so a long-suspended device picks up state
  // changes elsewhere before the user touches anything. We deliberately
  // do NOT toggle syncingCount here so the overlay doesn't flash on
  // every tab switch.
  progress.pullAndMerge()
}

function reLogin() {
  auth.logout()
  router.replace({ name: 'login' })
}

onMounted(() => {
  auth.hydrate()
  document.addEventListener('visibilitychange', onVisible)
})

onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisible)
})
</script>

<template>
  <!-- Sync problems have to be visible. Silent failure is what let one
       account run 78 days on localStorage alone without anyone noticing. -->
  <div v-if="showBanner" class="sync-banner" :class="{ severe: syncStatus.expired }">
    <template v-if="syncStatus.expired">
      <span>⚠ 登入已過期,成績目前只存在這台裝置</span>
      <button class="banner-btn" @click="reLogin">重新登入</button>
    </template>
    <template v-else-if="syncStatus.pending > 0">
      <span>⚠ 尚未同步,{{ syncStatus.pending }} 筆待上傳</span>
    </template>
    <template v-else>
      <span>⚠ 無法連線到伺服器,成績暫存在這台裝置</span>
    </template>
  </div>

  <div class="app-shell">
    <router-view />
  </div>

  <!-- Captures all pointer + key input while a user-initiated sync is in
       flight, so a stray finger landing on a button right after submit
       can't fire a second action against stale state. -->
  <transition name="fade">
    <div v-if="syncing" class="sync-overlay" aria-busy="true" aria-live="polite">
      <div class="sync-panel">
        <span class="spinner" />
        <span>同步中…</span>
      </div>
    </div>
  </transition>
</template>
