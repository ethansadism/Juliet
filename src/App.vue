<script setup>
import { computed, onMounted, onUnmounted } from 'vue'
import { useAuthStore } from './stores/auth.js'
import { useProgressStore } from './stores/progress.js'
import { syncingCount } from './lib/sync.js'

const auth = useAuthStore()
const progress = useProgressStore()

const syncing = computed(() => syncingCount.value > 0)

function onVisible() {
  if (document.visibilityState !== 'visible') return
  if (!auth.user) return
  // Silent re-pull on focus so a long-suspended device picks up state
  // changes elsewhere before the user touches anything. We deliberately
  // do NOT toggle syncingCount here so the overlay doesn't flash on
  // every tab switch — it'll show next time the user takes an action.
  progress.pullAndMerge()
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
