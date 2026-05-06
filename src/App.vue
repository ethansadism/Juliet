<script setup>
import { onMounted, onUnmounted } from 'vue'
import { useAuthStore } from './stores/auth.js'
import { useProgressStore } from './stores/progress.js'

const auth = useAuthStore()
const progress = useProgressStore()

function onVisible() {
  if (document.visibilityState !== 'visible') return
  if (!auth.user) return
  // Re-pull when the tab regains focus so a long-suspended device picks
  // up state changes made elsewhere before the user touches anything.
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
</template>
