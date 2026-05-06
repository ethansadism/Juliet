<script setup>
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useProgressStore } from '../stores/progress.js'

const router = useRouter()
const progress = useProgressStore()

onMounted(() => progress.hydrate())

const exams = computed(() => [...progress.exams].reverse())

function summarize(ex) {
  const total = ex.questionIds.length
  let correct = 0
  for (const a of Object.values(ex.answers)) if (a.correct) correct++
  return { total, correct, percent: total === 0 ? 0 : (correct / total) * 100 }
}

function durationFmt(ex) {
  if (!ex.finishedAt) return '—'
  const sec = Math.round((new Date(ex.finishedAt) - new Date(ex.startedAt)) / 1000)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m ${s}s`
}

function indexOf(ex) {
  return progress.exams.findIndex((e) => e.id === ex.id) + 1
}
</script>

<template>
  <div>
    <div class="topbar">
      <button class="btn ghost" style="width: auto; padding: 6px 10px; margin: 0" @click="router.back()">
        ←
      </button>
      <h1>試後檢討</h1>
      <span />
    </div>

    <p v-if="!exams.length" class="muted">尚無歷史紀錄</p>

    <button
      v-for="ex in exams"
      :key="ex.id"
      class="history-row"
      @click="router.push({ name: 'review', params: { examId: ex.id } })"
    >
      <div>
        <div>第 {{ indexOf(ex) }} 次</div>
        <div class="meta">{{ new Date(ex.startedAt).toLocaleString() }}</div>
        <div class="meta">{{ durationFmt(ex) }} · {{ ex.questionIds.length }} 題</div>
      </div>
      <div class="score">
        {{ Math.round(summarize(ex).percent) }}%
      </div>
    </button>
  </div>
</template>
