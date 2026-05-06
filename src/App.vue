<script setup>
import { onMounted } from 'vue'
import { useAuthStore } from './stores/auth.js'

const auth = useAuthStore()
onMounted(() => auth.hydrate())
</script>

<template>
  <div class="app-shell">
    <router-view />
  </div>
</template>
