<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'
import { useProgressStore } from '../stores/progress.js'
import { useQuestionsStore } from '../stores/questions.js'
import { withSync } from '../lib/sync.js'

const router = useRouter()
const auth = useAuthStore()
const progress = useProgressStore()
const questions = useQuestionsStore()

onMounted(async () => {
  progress.hydrate()
  // Question load runs concurrently; the overlay only covers the cloud
  // pull, since blocking input during the JSON download would feel
  // heavier than necessary.
  questions.load()
  await withSync(() => progress.pullAndMerge())
})

const total = computed(() => questions.total || 0)
const totalAttempts = computed(() => progress.totalAttempts)
const coverPercent = computed(() => {
  if (!total.value) return 0
  return (totalAttempts.value / total.value) * 100
})
// Distinct coverage next to total attempts makes the repeat rate visible:
// the gap between the two numbers is exactly how much has been re-served.
const distinctSeen = computed(() => progress.answeredQuestionCount)
const distinctPercent = computed(() =>
  total.value ? (distinctSeen.value / total.value) * 100 : 0,
)
const correctRate = computed(() => progress.correctRate * 100)
const avg100 = computed(() => progress.avgSecondsPer100)
const lastActivity = computed(() => {
  if (!progress.lastActivityAt) return '—'
  const d = new Date(progress.lastActivityAt)
  return d.toLocaleString()
})

const hasActive = computed(() => !!progress.activeExam)
const hasHistory = computed(() => progress.exams.length > 0)

const wrongPoolSize = computed(() => progress.wrongQuestionIds.length)
const knownPoolSize = computed(() => progress.knownQuestionIds.length)
const questionsPerExam = ref(progress.settings.questionsPerExam)
const errorBar = ref(progress.settings.errorBarPercent)
const knownBar = ref(progress.settings.knownBarPercent)

watch(
  () => progress.settings,
  (s) => {
    questionsPerExam.value = s.questionsPerExam
    errorBar.value = s.errorBarPercent
    knownBar.value = s.knownBarPercent
  },
  { deep: true },
)

const examSize = computed(() => Math.max(1, Number(questionsPerExam.value) || 1))
// Each bar is a share of this exam, so the count is predictable no matter
// how big the pool behind it grows. (It used to be a share of the pool,
// which meant 21% could quietly mean "every question in the exam".)
const errorIncluded = computed(() =>
  Math.min(wrongPoolSize.value, Math.round((errorBar.value / 100) * examSize.value)),
)
const knownIncluded = computed(() =>
  Math.min(knownPoolSize.value, Math.round((knownBar.value / 100) * examSize.value)),
)
const errorBarDisabled = computed(
  () => totalAttempts.value === 0 || wrongPoolSize.value === 0,
)
const knownBarDisabled = computed(() => knownPoolSize.value === 0)

// Both bars measure the same exam, so together they simply may not exceed
// 100%. Capping `max` stops the drag at the boundary rather than silently
// reallocating afterwards.
const errorBarMax = computed(() => (errorBarDisabled.value ? 0 : 100 - knownBar.value))
const knownBarMax = computed(() => (knownBarDisabled.value ? 0 : 100 - errorBar.value))
const atCapacity = computed(() => errorBar.value + knownBar.value >= 100)

// Lowering the question count (or losing pool entries) can strand a slider
// above its new cap; pull it back down instead of overfilling the exam.
watch([errorBarMax, knownBarMax], () => {
  let changed = false
  if (errorBar.value > errorBarMax.value) {
    errorBar.value = errorBarMax.value
    changed = true
  }
  if (knownBar.value > knownBarMax.value) {
    knownBar.value = knownBarMax.value
    changed = true
  }
  if (changed) commitSettings()
})

function commitSettings() {
  progress.updateSettings({
    questionsPerExam: Math.max(1, Math.min(total.value || 3664, Number(questionsPerExam.value) || 1)),
    errorBarPercent: Math.min(errorBarMax.value, Number(errorBar.value) || 0),
    knownBarPercent: Math.min(knownBarMax.value, Number(knownBar.value) || 0),
  })
}

async function startExam() {
  commitSettings()
  if (progress.activeExam) await progress.cancelActive()
  const ids = questions.questions.map((q) => q.id)
  if (!ids.length) return
  const exam = progress.startExam(ids)
  // Possible when every remaining question is marked 我會了 and the
  // review bar is at 0% — starting it would strand the user on a blank
  // exam screen.
  if (!exam.questionIds.length) {
    progress.cancelActive()
    alert('依目前設定沒有可出的題目。請調高「複習我會了的題目」比例,或取消部分「我會了」標記。')
    return
  }
  router.push({ name: 'exam' })
}

function continueExam() {
  if (!progress.activeExam) return
  router.push({ name: 'exam' })
}

async function discardActive() {
  if (!confirm('確定要捨棄目前未完成的測驗嗎?')) return
  await progress.cancelActive()
}

function logout() {
  auth.logout()
  router.replace({ name: 'login' })
}

function fmt2(n) {
  return Math.round(n * 100) / 100
}
</script>

<template>
  <div>
    <div class="topbar">
      <h1>月月 模擬考</h1>
      <div style="display: flex; gap: 6px">
        <button
          v-if="auth.isAdmin"
          class="btn ghost"
          style="width: auto; padding: 8px 12px; margin: 0"
          @click="router.push({ name: 'admin' })"
        >
          管理
        </button>
        <button class="btn ghost" style="width: auto; padding: 8px 12px; margin: 0" @click="logout">
          登出
        </button>
      </div>
    </div>

    <div v-if="questions.error" class="error">無法載入題庫:{{ questions.error }}</div>
    <div v-else-if="!questions.loaded" class="muted">載入題庫中…</div>

    <div v-else>
      <div class="card">
        <h2>{{ auth.user?.displayName }} 的進度</h2>
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label">已考過題目</div>
            <div class="stat-value">
              {{ totalAttempts }}/{{ total }}
              <span class="muted" style="font-size: 13px">
                ({{ fmt2(coverPercent) }}%)
              </span>
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">不重複涵蓋</div>
            <div class="stat-value">
              {{ distinctSeen }}/{{ total }}
              <span class="muted" style="font-size: 13px">
                ({{ fmt2(distinctPercent) }}%)
              </span>
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">正確率</div>
            <div class="stat-value">{{ fmt2(correctRate) }}%</div>
          </div>
          <div class="stat">
            <div class="stat-label">平均 100 題</div>
            <div class="stat-value">{{ Math.round(avg100) }} 秒</div>
          </div>
          <div class="stat">
            <div class="stat-label">上次做題</div>
            <div class="stat-value" style="font-size: 14px">{{ lastActivity }}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <button class="btn primary" @click="startExam">
          開始測驗
        </button>
        <button v-if="hasActive" class="btn" @click="continueExam">
          繼續測驗 ({{ Object.keys(progress.activeExam.answers).length }}/{{
            progress.activeExam.questionIds.length
          }})
        </button>
        <button v-if="hasActive" class="btn danger" @click="discardActive">
          捨棄未完成的測驗
        </button>
        <button class="btn ghost" :disabled="!hasHistory" @click="router.push({ name: 'review-list' })">
          試後檢討
        </button>
      </div>

      <div class="card">
        <h2>設定</h2>
        <div class="row">
          <label for="qpe">下次考試題數</label>
          <input
            id="qpe"
            class="input"
            type="number"
            min="1"
            :max="total"
            v-model.number="questionsPerExam"
            @change="commitSettings"
            style="max-width: 110px; text-align: right"
          />
        </div>

        <div class="row" style="flex-direction: column; align-items: stretch">
          <div class="row" style="margin-top: 0">
            <label>強制包含錯題</label>
            <span class="muted">
              {{ errorIncluded }} / {{ wrongPoolSize }}
            </span>
          </div>
          <input
            class="range"
            type="range"
            min="0"
            :max="errorBarMax"
            step="1"
            :disabled="errorBarDisabled"
            v-model.number="errorBar"
            @change="commitSettings"
          />
          <div class="muted" style="font-size: 12px; margin-top: 4px">
            {{ errorBar }}% = 本次 {{ errorIncluded }} 題
            <span v-if="errorBarDisabled">(尚無錯題,無法使用)</span>
            <span v-else-if="errorBarMax < 100">· 上限 {{ errorBarMax }}%</span>
          </div>
        </div>

        <div class="row" style="flex-direction: column; align-items: stretch">
          <div class="row" style="margin-top: 0">
            <label>複習「我會了」的題目</label>
            <span class="muted">
              {{ knownIncluded }} / {{ knownPoolSize }}
            </span>
          </div>
          <input
            class="range"
            type="range"
            min="0"
            :max="knownBarMax"
            step="1"
            :disabled="knownBarDisabled"
            v-model.number="knownBar"
            @change="commitSettings"
          />
          <div class="muted" style="font-size: 12px; margin-top: 4px">
            {{ knownBar }}% = 本次 {{ knownIncluded }} 題
            <span v-if="knownBarDisabled">(尚未標記任何題目)</span>
            <span v-else-if="knownBar === 0">· 0% = 這次完全略過</span>
            <span v-else-if="knownBarMax < 100">· 上限 {{ knownBarMax }}%</span>
          </div>
        </div>

        <p v-if="atCapacity" class="cap-warning">
          錯題 {{ errorBar }}% + 我會了 {{ knownBar }}% 已佔滿整份考卷,
          本次 {{ examSize }} 題不會有新題目。
        </p>
      </div>

      <p class="muted" style="text-align: center; font-size: 12px">
        題庫來源:{{ questions.sheets.map((s) => s.name).join(' / ') }} ·
        共 {{ total }} 題
      </p>
    </div>
  </div>
</template>
