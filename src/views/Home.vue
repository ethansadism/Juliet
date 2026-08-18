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
  // The bank has to be loaded before stored records can be translated off
  // the old question-id scheme, and the pull has to be translated too.
  await questions.load()
  await progress.applyLegacyMap(questions.legacyMap)
  await withSync(() => progress.pullAndMerge())
  await progress.applyLegacyMap(questions.legacyMap)
})

const total = computed(() => questions.total || 0)
const totalAttempts = computed(() => progress.totalAttempts)
// Distinct coverage is the only one of these worth a percentage: attempts
// counted against the bank size mixed two different units and would climb
// past 100% on re-tests. The gap between the two is the repeat count.
const distinctSeen = computed(() => progress.answeredQuestionCount)
const distinctPercent = computed(() =>
  total.value ? (distinctSeen.value / total.value) * 100 : 0,
)
const repeatCount = computed(() => Math.max(0, totalAttempts.value - distinctSeen.value))
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
const errorCount = ref(progress.settings.errorCount)
const knownCount = ref(progress.settings.knownCount)

watch(
  () => progress.settings,
  (s) => {
    questionsPerExam.value = s.questionsPerExam
    errorCount.value = s.errorCount
    knownCount.value = s.knownCount
  },
  { deep: true },
)

const examSize = computed(() => Math.max(1, Number(questionsPerExam.value) || 1))
const errorBarDisabled = computed(
  () => totalAttempts.value === 0 || wrongPoolSize.value === 0,
)
const knownBarDisabled = computed(() => knownPoolSize.value === 0)

// A slider can reach as far as its own pool allows, minus whatever the
// other one has already claimed of the exam. Both limits are real, so the
// hint below each bar says which one is binding.
const errorMax = computed(() =>
  errorBarDisabled.value
    ? 0
    : Math.min(wrongPoolSize.value, Math.max(0, examSize.value - knownCount.value)),
)
const knownMax = computed(() =>
  knownBarDisabled.value
    ? 0
    : Math.min(knownPoolSize.value, Math.max(0, examSize.value - errorCount.value)),
)
const errorLimitedByPool = computed(() => errorMax.value === wrongPoolSize.value)
const knownLimitedByPool = computed(() => knownMax.value === knownPoolSize.value)
const freshCount = computed(() =>
  Math.max(0, examSize.value - errorCount.value - knownCount.value),
)
const atCapacity = computed(() => freshCount.value === 0)

// Lowering the question count (or losing pool entries) can strand a slider
// above its new cap; pull it back down instead of overfilling the exam.
watch([errorMax, knownMax], () => {
  let changed = false
  if (errorCount.value > errorMax.value) {
    errorCount.value = errorMax.value
    changed = true
  }
  if (knownCount.value > knownMax.value) {
    knownCount.value = knownMax.value
    changed = true
  }
  if (changed) commitSettings()
})

function commitSettings() {
  progress.updateSettings({
    questionsPerExam: Math.max(1, Math.min(total.value || 3664, Number(questionsPerExam.value) || 1)),
    errorCount: Math.min(errorMax.value, Number(errorCount.value) || 0),
    knownCount: Math.min(knownMax.value, Number(knownCount.value) || 0),
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
            <div class="stat-label">題庫進度</div>
            <div class="stat-value">
              {{ distinctSeen }}/{{ total }}
              <span class="muted" style="font-size: 13px">
                ({{ fmt2(distinctPercent) }}%)
              </span>
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">累計作答</div>
            <div class="stat-value">
              {{ totalAttempts }} 題
              <span v-if="repeatCount > 0" class="muted" style="font-size: 13px">
                (含重複 {{ repeatCount }})
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
              本次 {{ errorCount }} 題 / 錯題共 {{ wrongPoolSize }} 題
            </span>
          </div>
          <input
            class="range"
            type="range"
            min="0"
            :max="errorMax"
            step="1"
            :disabled="errorBarDisabled"
            v-model.number="errorCount"
            @change="commitSettings"
          />
          <div class="muted" style="font-size: 12px; margin-top: 4px">
            <span v-if="errorBarDisabled">尚無錯題,無法使用</span>
            <span v-else-if="errorLimitedByPool">最多 {{ errorMax }} 題(錯題就這麼多)</span>
            <span v-else>最多 {{ errorMax }} 題(受考卷題數限制)</span>
          </div>
        </div>

        <div class="row" style="flex-direction: column; align-items: stretch">
          <div class="row" style="margin-top: 0">
            <label>複習「我會了」的題目</label>
            <span class="muted">
              本次 {{ knownCount }} 題 / 已標記 {{ knownPoolSize }} 題
            </span>
          </div>
          <input
            class="range"
            type="range"
            min="0"
            :max="knownMax"
            step="1"
            :disabled="knownBarDisabled"
            v-model.number="knownCount"
            @change="commitSettings"
          />
          <div class="muted" style="font-size: 12px; margin-top: 4px">
            <span v-if="knownBarDisabled">尚未標記任何題目</span>
            <span v-else-if="knownCount === 0">0 題 = 這次完全略過</span>
            <span v-else-if="knownLimitedByPool">最多 {{ knownMax }} 題(標記的就這麼多)</span>
            <span v-else>最多 {{ knownMax }} 題(受考卷題數限制)</span>
          </div>
        </div>

        <p class="muted" style="font-size: 13px; margin-top: 12px" :class="{ 'cap-warning': atCapacity }">
          本次組成:{{ errorCount }} 題錯題 + {{ knownCount }} 題複習 +
          <strong>{{ freshCount }} 題新題</strong>
          <span v-if="atCapacity">(已佔滿,不會有新題目)</span>
        </p>
      </div>

      <p class="muted" style="text-align: center; font-size: 12px">
        題庫來源:{{ questions.sheets.map((s) => s.name).join(' / ') }} ·
        共 {{ total }} 題
      </p>
    </div>
  </div>
</template>
