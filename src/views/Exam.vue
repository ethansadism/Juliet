<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useProgressStore } from '../stores/progress.js'
import { useQuestionsStore } from '../stores/questions.js'
import { isCorrect, normalizeLetter } from '../lib/parseQuestion.js'

const router = useRouter()
const progress = useProgressStore()
const questions = useQuestionsStore()

const elapsed = ref(0)
let timer = null

onMounted(async () => {
  progress.hydrate()
  await questions.load()
  if (!progress.activeExam) {
    router.replace({ name: 'home' })
    return
  }
  tick()
  timer = setInterval(tick, 1000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

function tick() {
  if (!progress.activeExam) return
  elapsed.value = Math.floor(
    (Date.now() - new Date(progress.activeExam.startedAt).getTime()) / 1000,
  )
}

const exam = computed(() => progress.activeExam)
const idx = computed(() => exam.value?.currentIndex ?? 0)
const totalQ = computed(() => exam.value?.questionIds.length ?? 0)
const currentQid = computed(() => exam.value?.questionIds[idx.value])
const currentQ = computed(() => questions.byId.get(currentQid.value))
const answeredCount = computed(() =>
  exam.value ? Object.keys(exam.value.answers).length : 0,
)
const currentAnswer = computed(() => exam.value?.answers[currentQid.value])

const elapsedFmt = computed(() => {
  const s = elapsed.value
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
})

function selectOption(letter) {
  if (!currentQ.value) return
  progress.answerActive(currentQid.value, letter, currentQ.value.answer)
}

function goPrev() {
  if (idx.value > 0) progress.setActiveIndex(idx.value - 1)
}

function goNext() {
  if (idx.value < totalQ.value - 1) progress.setActiveIndex(idx.value + 1)
}

function submitExam() {
  const unanswered = totalQ.value - answeredCount.value
  if (unanswered > 0 && !confirm(`還有 ${unanswered} 題未作答,確定提交?`)) return
  const ex = progress.submitActive()
  if (ex) router.replace({ name: 'review', params: { examId: ex.id } })
}

function jumpFirstUnanswered() {
  if (!exam.value) return
  for (let i = 0; i < exam.value.questionIds.length; i++) {
    if (!exam.value.answers[exam.value.questionIds[i]]) {
      progress.setActiveIndex(i)
      return
    }
  }
}
</script>

<template>
  <div v-if="exam && currentQ">
    <div class="exam-header">
      <span>{{ idx + 1 }}/{{ totalQ }} (已答 {{ answeredCount }})</span>
      <span>{{ elapsedFmt }}</span>
    </div>

    <div class="q-prompt">{{ currentQ.prompt }}</div>

    <button
      v-for="opt in currentQ.options"
      :key="opt.letter"
      class="option"
      :class="{
        selected:
          currentAnswer && normalizeLetter(currentAnswer.selected) === normalizeLetter(opt.letter),
      }"
      @click="selectOption(opt.letter)"
    >
      <span class="letter">{{ opt.letter }}</span>
      <span style="flex: 1">{{ opt.text }}</span>
    </button>

    <div v-if="!currentQ.options.length" class="muted" style="margin-top: 8px">
      (此題選項未能解析,顯示原文 — 請至檢討畫面查看)
    </div>

    <div class="bottom-bar">
      <button class="btn ghost" :disabled="idx === 0" @click="goPrev">
        ← 上一題
      </button>
      <button v-if="idx < totalQ - 1" class="btn" @click="goNext">下一題 →</button>
      <button v-else class="btn primary" @click="submitExam">提交</button>
    </div>

    <div style="margin-top: 8px; display: flex; gap: 8px">
      <button class="btn ghost" style="margin-top: 0" @click="jumpFirstUnanswered">
        跳到第一個未作答
      </button>
      <button
        class="btn ghost"
        style="margin-top: 0"
        @click="router.push({ name: 'home' })"
      >
        回首頁(保留進度)
      </button>
    </div>
  </div>
</template>
