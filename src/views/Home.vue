<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'
import { useProgressStore } from '../stores/progress.js'
import { useQuestionsStore } from '../stores/questions.js'

const router = useRouter()
const auth = useAuthStore()
const progress = useProgressStore()
const questions = useQuestionsStore()

onMounted(async () => {
  progress.hydrate()
  await questions.load()
})

const total = computed(() => questions.total || 0)
const totalAttempts = computed(() => progress.totalAttempts)
const coverPercent = computed(() => {
  if (!total.value) return 0
  return (totalAttempts.value / total.value) * 100
})
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
const errorBar = ref(progress.settings.errorBarPercent)
const questionsPerExam = ref(progress.settings.questionsPerExam)
const skipKnown = ref(progress.settings.skipKnown)

watch(
  () => progress.settings,
  (s) => {
    errorBar.value = s.errorBarPercent
    questionsPerExam.value = s.questionsPerExam
    skipKnown.value = s.skipKnown
  },
  { deep: true },
)

const errorIncluded = computed(() =>
  Math.round((errorBar.value / 100) * wrongPoolSize.value),
)
const errorBarDisabled = computed(
  () => totalAttempts.value === 0 || wrongPoolSize.value === 0,
)

function commitSettings() {
  progress.updateSettings({
    questionsPerExam: Math.max(1, Math.min(total.value || 3664, Number(questionsPerExam.value) || 1)),
    errorBarPercent: Math.max(0, Math.min(100, Number(errorBar.value) || 0)),
    skipKnown: !!skipKnown.value,
  })
}

function startExam() {
  commitSettings()
  if (progress.activeExam) progress.cancelActive()
  const ids = questions.questions.map((q) => q.id)
  if (!ids.length) return
  progress.startExam(ids)
  router.push({ name: 'exam' })
}

function continueExam() {
  if (!progress.activeExam) return
  router.push({ name: 'exam' })
}

function discardActive() {
  if (!confirm('確定要捨棄目前未完成的測驗嗎?')) return
  progress.cancelActive()
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
            max="100"
            step="1"
            :disabled="errorBarDisabled"
            v-model.number="errorBar"
            @change="commitSettings"
          />
          <div class="muted" style="font-size: 12px; margin-top: 4px">
            {{ errorBar }}%
            <span v-if="errorBarDisabled">(尚無錯題,無法使用)</span>
          </div>
        </div>

        <div class="row">
          <label for="skip">略過已標記「我會了」的題目</label>
          <label class="switch">
            <input
              id="skip"
              type="checkbox"
              v-model="skipKnown"
              @change="commitSettings"
            />
            <span class="slider" />
          </label>
        </div>
      </div>

      <p class="muted" style="text-align: center; font-size: 12px">
        題庫來源:{{ questions.sheets.map((s) => s.name).join(' / ') }} ·
        共 {{ total }} 題
      </p>
    </div>
  </div>
</template>
