<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { apiFetch, ApiError } from "../api/client.js";
import EmptyState from "../components/EmptyState.vue";
import LoadingBlock from "../components/LoadingBlock.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { planStatusLabels } from "../utils/format.js";

interface PlanSummary {
  id: string;
  title: string;
  status: keyof typeof planStatusLabels;
  isTemplate: boolean;
  versionNumber: number;
  chainHead: boolean;
  lockedAt: string | null;
  copiedFromId: string | null;
  totalTasks: number;
  doneTasks: number;
  skippedTasks: number;
  progressPct: number;
  updatedAt: string;
  goal: { id: string; title: string; status: string } | null;
}
interface GoalOption {
  id: string;
  title: string;
  status: string;
}

const plans = ref<PlanSummary[]>([]);
const goals = ref<GoalOption[]>([]);
const router = useRouter();
const status = ref("");
const templatesOnly = ref(false);
const loading = ref(true);
const error = ref("");
const creating = ref(false);
const form = reactive({
  title: "",
  instrument: "",
  goalId: "",
  isTemplate: false,
  dueDate: "",
  description: "",
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const params = new URLSearchParams({ limit: "100", headOnly: "true" });
    if (status.value) params.set("status", status.value);
    if (templatesOnly.value) params.set("isTemplate", "true");
    const [planResult, goalResult] = await Promise.all([
      apiFetch<{ data: PlanSummary[] }>(`/api/v1/plans?${params.toString()}`),
      apiFetch<{ data: GoalOption[] }>("/api/v1/goals?limit=100"),
    ]);
    plans.value = planResult.data;
    goals.value = goalResult.data.filter((goal) => ["OPEN", "IN_PROGRESS"].includes(goal.status));
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "计划加载失败";
  } finally {
    loading.value = false;
  }
}

async function createPlan(): Promise<void> {
  const created = await apiFetch<{ plan: PlanSummary }>("/api/v1/plans", {
    method: "POST",
    body: JSON.stringify({
      title: form.title,
      instrument: form.instrument || null,
      goalId: form.goalId || null,
      isTemplate: form.isTemplate,
      description: form.description || null,
      dueDate: form.dueDate ? new Date(`${form.dueDate}T12:00:00.000Z`).toISOString() : null,
      phases: [],
    }),
  });
  creating.value = false;
  form.title = "";
  form.description = "";
  await router.push(`/plans/${created.plan.id}`);
}

onMounted(load);
</script>

<template>
  <section class="page">
    <header class="page-header">
      <div>
        <h1>计划编排</h1>
        <p>把目标拆成阶段与任务，执行时关联音频证据；模板可复制、锁定后改版生成新版本，进度随时可复算。</p>
      </div>
      <button class="button" @click="creating = !creating">新建计划</button>
    </header>

    <div class="tabs" style="margin-bottom: 18px">
      <button class="tab" :class="{ active: status === '' && !templatesOnly }" @click="status = ''; templatesOnly = false; load()">全部</button>
      <button
        v-for="item in ['DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED'] as const"
        :key="item"
        class="tab"
        :class="{ active: status === item && !templatesOnly }"
        @click="status = item; templatesOnly = false; load()"
      >
        {{ planStatusLabels[item] }}
      </button>
      <button class="tab" :class="{ active: templatesOnly }" @click="templatesOnly = true; load()">模板库</button>
    </div>

    <form v-if="creating" class="card form-grid" style="margin-bottom: 18px" @submit.prevent="createPlan">
      <label class="field full"><span>计划标题</span><input v-model="form.title" required maxlength="160" placeholder="例如：音准专项四周计划" /></label>
      <label class="field"><span>乐器</span><input v-model="form.instrument" maxlength="60" placeholder="可留空" /></label>
      <label class="field">
        <span>关联目标</span>
        <select v-model="form.goalId">
          <option value="">不关联</option>
          <option v-for="goal in goals" :key="goal.id" :value="goal.id">{{ goal.title }}</option>
        </select>
      </label>
      <label class="field"><span>目标完成日</span><input v-model="form.dueDate" type="date" /></label>
      <label class="field checkbox"><span>存为模板</span><input v-model="form.isTemplate" type="checkbox" /></label>
      <label class="field full"><span>计划说明</span><textarea v-model="form.description" maxlength="5000" /></label>
      <div class="row end full">
        <button class="button ghost" type="button" @click="creating = false">取消</button>
        <button class="button" type="submit">创建并编排</button>
      </div>
    </form>

    <LoadingBlock v-if="loading" />
    <div v-else-if="error" class="alert">{{ error }} <button class="button small ghost" @click="load">重试</button></div>
    <EmptyState
      v-else-if="!plans.length"
      title="还没有练习计划"
      description="创建一个计划，把目标拆成阶段和任务，练习时用音频证据说话。"
      action-label="新建计划"
      @action="creating = true"
    />
    <div v-else class="plans-grid">
      <article v-for="plan in plans" :key="plan.id" class="card stack plan-card" @click="$router.push(`/plans/${plan.id}`)">
        <div class="row between">
          <div class="row wrap" style="gap: 6px">
            <StatusBadge :value="plan.status" kind="plan" />
            <span v-if="plan.isTemplate" class="badge TEMPLATE">模板</span>
            <span v-if="plan.lockedAt" class="badge LOCKED">已锁定</span>
            <span class="badge">v{{ plan.versionNumber }}</span>
          </div>
          <small class="muted">{{ plan.updatedAt.slice(0, 10) }} 更新</small>
        </div>
        <div>
          <h2>{{ plan.title }}</h2>
          <p v-if="plan.goal" class="muted">目标：{{ plan.goal.title }}</p>
          <p v-if="plan.copiedFromId" class="muted">由模板或计划复制而来，谱系可查</p>
        </div>
        <div class="progress-line">
          <div class="progress-track"><div class="progress-fill" :style="{ width: `${plan.progressPct}%` }" /></div>
          <small class="muted">{{ plan.doneTasks }}/{{ plan.totalTasks }} 任务 · {{ plan.progressPct }}%</small>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.plans-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 17px; }
.plan-card { cursor: pointer; transition: border-color 0.15s ease; }
.plan-card:hover { border-color: var(--primary); }
.progress-line { display: grid; gap: 6px; }
.progress-track { height: 8px; border-radius: 999px; background: var(--surface-soft); overflow: hidden; }
.progress-fill { height: 100%; border-radius: 999px; background: var(--primary); transition: width 0.3s ease; }
.badge.TEMPLATE { background: #faead9; color: #9a5715; }
.badge.LOCKED { background: #f8e5e1; color: #93372d; }
.checkbox { align-content: end; }
.checkbox input { width: 18px; height: 18px; }
@media (max-width: 900px) { .plans-grid { grid-template-columns: 1fr; } }
</style>
