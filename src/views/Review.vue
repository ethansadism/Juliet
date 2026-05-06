<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useProgressStore } from '../stores/progress.js'
import { useQuestionsStore } from '../stores/questions.js'
import { normalizeLetter } from '../lib/parseQuestion.js'

const props = defineProps({ examId: { type: String, required: true } })
const router = useRouter()
const progress = useProgressStore()
const questions = useQuestionsStore()

const hideCorrect = ref(false)

onMounted(async () => {
  progress.hydrate()
  await questions.load()
})

const exam = computed(() => progress.getExam(props.examId))

const summary = computed(() => {
  if (!exam.value) return null
  const total = exam.value.questionIds.length
  let correct = 0
  for (const a of Object.values(exam.value.answers)) if (a.correct) correct++
  const sec = exam.value.finishedAt
    ? Math.round((new Date(exam.value.finishedAt) - new Date(exam.value.startedAt)) / 1000)
    : 0
  const per100 = total ? Math.round((sec / total) * 100) : 0
  return {
    total,
    correct,
    percent: total === 0 ? 0 : (correct / total) * 100,
    seconds: sec,
    per100,
  }
})

function durFmt(s) {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}m ${sec}s`
}

const items = computed(() => {
  if (!exam.value) return []
  const arr = []
  exam.value.questionIds.forEach((qid, i) => {
    const q = questions.byId.get(qid)
    if (!q) return
    const ans = exam.value.answers[qid]
    const stat = progress.questionStats[qid]
    arr.push({
      i: i + 1,
      qid,
      q,
      ans,
      timesWrong: stat?.timesWrong ?? 0,
      knownByUser: progress.knownSet.has(qid),
    })
  })
  return arr
})

const visibleItems = computed(() =>
  hideCorrect.value ? items.value.filter((it) => !it.ans?.correct) : items.value,
)

function toggleKnown(qid, val) {
  progress.setKnown(qid, val)
}
</script>

<template>
  <div v-if="exam">
    <div class="topbar">
      <button class="btn ghost" style="width: auto; padding: 6px 10px; margin: 0" @click="router.back()">
        ←
      </button>
      <h1>試後檢討</h1>
      <span />
    </div>

    <div class="card">
      <div class="stat-grid">
        <div class="stat">
          <div class="stat-label">正確率</div>
          <div class="stat-value">
            {{ Math.round(summary.percent) }}%
            <span class="muted" style="font-size: 13px">
              ({{ summary.correct }}/{{ summary.total }})
            </span>
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">用時</div>
          <div class="stat-value">{{ durFmt(summary.seconds) }}</div>
        </div>
        <div class="stat" style="grid-column: 1 / -1">
          <div class="stat-label">平均 100 題</div>
          <div class="stat-value">{{ summary.per100 }} 秒</div>
        </div>
      </div>
      <div class="row" style="margin-top: 12px">
        <label>隱藏已答對題目</label>
        <label class="switch">
          <input type="checkbox" v-model="hideCorrect" />
          <span class="slider" />
        </label>
      </div>
    </div>

    <div
      v-for="it in visibleItems"
      :key="it.qid"
      class="review-item"
      :class="{ wrong: it.ans && !it.ans.correct, correct: it.ans?.correct }"
    >
      <div class="row" style="margin-bottom: 6px">
        <div>
          <strong>第 {{ it.i }} 題</strong>
          <span v-if="it.ans?.correct" class="badge good">答對</span>
          <span v-else-if="it.ans" class="badge bad">答錯</span>
          <span v-else class="badge">未作答</span>
          <span v-if="it.timesWrong > 1" class="badge bad">x{{ it.timesWrong }}!!</span>
        </div>
      </div>
      <div class="q-prompt" style="font-size: 16px">{{ it.q.prompt }}</div>
      <div
        v-for="opt in it.q.options"
        :key="opt.letter"
        class="option"
        :class="{
          correct: normalizeLetter(opt.letter) === normalizeLetter(it.q.answer),
          wrong:
            it.ans &&
            !it.ans.correct &&
            normalizeLetter(it.ans.selected) === normalizeLetter(opt.letter),
        }"
      >
        <span class="letter">{{ opt.letter }}</span>
        <span style="flex: 1">{{ opt.text }}</span>
      </div>
      <div v-if="!it.q.options.length" class="muted" style="font-size: 13px">
        (此題選項未能解析,標準答案:{{ it.q.answer }})
      </div>
      <div v-if="it.ans?.correct" class="row" style="margin-top: 10px">
        <label>標記「我會了」(下次測驗略過)</label>
        <label class="switch">
          <input
            type="checkbox"
            :checked="it.knownByUser"
            @change="toggleKnown(it.qid, $event.target.checked)"
          />
          <span class="slider" />
        </label>
      </div>
    </div>

    <p v-if="!visibleItems.length" class="muted" style="text-align: center">
      沒有要顯示的題目。
    </p>

    <button class="btn ghost" @click="router.push({ name: 'home' })">回首頁</button>
  </div>
  <div v-else>
    <p class="error">找不到此次測驗紀錄。</p>
    <button class="btn" @click="router.replace({ name: 'review-list' })">返回列表</button>
  </div>
</template>
