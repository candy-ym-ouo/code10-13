<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiFetch, ApiError } from "../api/client.js";
import LoadingBlock from "../components/LoadingBlock.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { evidenceRequirementLabels, formatDateTime, formatDuration, planTaskStatusLabels } from "../utils/format.js";

type EvidenceRequirement = keyof typeof evidenceRequirementLabels;
type TaskStatus = keyof typeof planTaskStatusLabels;

interface Evidence {
  id: string;
  note: string | null;
  createdAt: string;
  media: { id: string; sessionId: string; originalName: string; status: string; durationMs: number | null };
}
interface PlanTask {
  id: string;
  phaseId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  evidenceRequirement: EvidenceRequirement;
  estimateMinutes: number | null;
  dueDate: string | null;
  selfReviewNote: string | null;
  completedAt: string | null;
  linkedGoal: { id: string; title: string; status: string } | null;
  evidences: Evidence[];
}
interface PlanPhase {
  id: string;
  title: string;
  description: string | null;
  totalTasks: number;
  doneTasks: number;
  skippedTasks: number;
  progressPct: number;
  tasks: PlanTask[];
}
interface PlanDetail {
  id: string;
  title: string;
  description: string | null;
  instrument: string | null;
  status: "DRAFT" | "ACTIVE" | "COMPLETED" | "ARCHIVED";
  isTemplate: boolean;
  versionNumber: number;
  chainHead: boolean;
  lockedAt: string | null;
  changeNote: string | null;
  copiedFromId: string | null;
  totalTasks: number;
  doneTasks: number;
  skippedTasks: number;
  progressPct: number;
  recomputedAt: string | null;
  dueDate: string | null;
  revision: number;
  createdAt: string;
  goal: { id: string; title: string; status: string; targetValue: number; unit: string } | null;
  phases: PlanPhase[];
}
interface LineageItem {
  id: string;
  title: string;
  status: string;
  isTemplate: boolean;
  versionNumber: number;
  chainHead: boolean;
  lockedAt: string | null;
  progressPct: number;
  createdAt: string;
}
interface MediaOption {
  id: string;
  originalName: string;
  durationMs: number | null;
  session: { id: string; title: string };
}
interface GoalOption {
  id: string;
  title: string;
  status: string;
}

const route = useRoute();
const router = useRouter();
const plan = ref<PlanDetail | null>(null);
const ancestors = ref<LineageItem[]>([]);
const family = ref<LineageItem[]>([]);
const versions = ref<LineageItem[]>([]);
const goals = ref<GoalOption[]>([]);
const mediaOptions = ref<MediaOption[]>([]);
const loading = ref(true);
const error = ref("");
const actionError = ref("");
const addingPhase = ref(false);
const showLineage = ref(false);
const newPhase = reactive({ title: "", description: "" });
const taskForms = reactive<Record<string, { open: boolean; title: string; evidenceRequirement: EvidenceRequirement; estimateMinutes: string; linkedGoalId: string }>>({});
const evidencePanels = reactive<Record<string, { open: boolean; mediaId: string; note: string }>>({});

const canEditStructure = computed(() => Boolean(plan.value && !plan.value.lockedAt));
const canExecute = computed(() => Boolean(plan.value && !plan.value.isTemplate && plan.value.chainHead));

async function refresh(): Promise<void> {
  const id = route.params.id as string;
  const [detail, lineage, versionList, goalResult] = await Promise.all([
    apiFetch<{ plan: PlanDetail }>(`/api/v1/plans/${id}`),
    apiFetch<{ ancestors: LineageItem[]; family: LineageItem[] }>(`/api/v1/plans/${id}/lineage`),
    apiFetch<{ data: LineageItem[] }>(`/api/v1/plans/${id}/versions`),
    apiFetch<{ data: GoalOption[] }>("/api/v1/goals?limit=100"),
  ]);
  plan.value = detail.plan;
  ancestors.value = lineage.ancestors;
  family.value = lineage.family;
  versions.value = versionList.data;
  goals.value = goalResult.data.filter((goal) => ["OPEN", "IN_PROGRESS"].includes(goal.status));
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    await refresh();
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "计划加载失败";
  } finally {
    loading.value = false;
  }
}

async function run(action: () => Promise<unknown>): Promise<void> {
  actionError.value = "";
  try {
    await action();
  } catch (reason) {
    if (reason instanceof ApiError && Array.isArray(reason.details)) {
      actionError.value = (reason.details as string[]).join("；");
    } else {
      actionError.value = reason instanceof ApiError ? reason.message : "操作失败，请重试";
    }
  }
}

async function simpleAction(path: string, confirmText?: string): Promise<void> {
  if (confirmText && !window.confirm(confirmText)) return;
  await run(async () => {
    await apiFetch(path, { method: "POST", body: "{}" });
    await refresh();
  });
}

async function revisePlan(): Promise<void> {
  const changeNote = window.prompt("本次改版说明（可留空）：") ?? "";
  await run(async () => {
    const result = await apiFetch<{ plan: PlanDetail }>(`/api/v1/plans/${plan.value!.id}/revise`, {
      method: "POST",
      body: JSON.stringify({ changeNote: changeNote || null }),
    });
    await router.push(`/plans/${result.plan.id}`);
  });
}

async function copyPlan(asTemplate = false): Promise<void> {
  const title = window.prompt("新计划标题：", `${plan.value!.title}（副本）`);
  if (!title) return;
  await run(async () => {
    const result = await apiFetch<{ plan: PlanDetail }>(`/api/v1/plans/${plan.value!.id}/copy`, {
      method: "POST",
      body: JSON.stringify({ title, asTemplate }),
    });
    await router.push(`/plans/${result.plan.id}`);
  });
}

async function addPhase(): Promise<void> {
  await run(async () => {
    await apiFetch(`/api/v1/plans/${plan.value!.id}/phases`, {
      method: "POST",
      body: JSON.stringify({ title: newPhase.title, description: newPhase.description || null }),
    });
    newPhase.title = "";
    newPhase.description = "";
    addingPhase.value = false;
    await refresh();
  });
}

async function renamePhase(phase: PlanPhase): Promise<void> {
  const title = window.prompt("阶段标题：", phase.title);
  if (!title) return;
  await run(async () => {
    await apiFetch(`/api/v1/plans/${plan.value!.id}/phases/${phase.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
    await refresh();
  });
}

async function removePhase(phase: PlanPhase): Promise<void> {
  if (!window.confirm(`删除阶段“${phase.title}”及其全部任务？`)) return;
  await run(async () => {
    await apiFetch(`/api/v1/plans/${plan.value!.id}/phases/${phase.id}`, { method: "DELETE" });
    await refresh();
  });
}

function taskForm(phaseId: string) {
  taskForms[phaseId] ??= { open: false, title: "", evidenceRequirement: "NONE", estimateMinutes: "", linkedGoalId: "" };
  return taskForms[phaseId];
}

async function addTask(phaseId: string): Promise<void> {
  const form = taskForm(phaseId);
  await run(async () => {
    await apiFetch(`/api/v1/plans/${plan.value!.id}/phases/${phaseId}/tasks`, {
      method: "POST",
      body: JSON.stringify({
        title: form.title,
        evidenceRequirement: form.evidenceRequirement,
        estimateMinutes: form.estimateMinutes === "" ? null : Number(form.estimateMinutes),
        linkedGoalId: form.linkedGoalId || null,
      }),
    });
    form.title = "";
    form.estimateMinutes = "";
    form.open = false;
    await refresh();
  });
}

async function removeTask(task: PlanTask): Promise<void> {
  if (!window.confirm(`删除任务“${task.title}”？`)) return;
  await run(async () => {
    await apiFetch(`/api/v1/plans/${plan.value!.id}/tasks/${task.id}`, { method: "DELETE" });
    await refresh();
  });
}

async function setTaskStatus(task: PlanTask, status: TaskStatus): Promise<void> {
  let selfReviewNote: string | undefined;
  if (status === "DONE" && ["SELF_REVIEW", "AUDIO_AND_SELF_REVIEW"].includes(task.evidenceRequirement)) {
    const note = window.prompt("请填写本次自评说明：", task.selfReviewNote ?? "");
    if (!note) return;
    selfReviewNote = note;
  }
  await run(async () => {
    const result = await apiFetch<{ plan: PlanDetail }>(`/api/v1/plans/${plan.value!.id}/tasks/${task.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status, ...(selfReviewNote === undefined ? {} : { selfReviewNote }) }),
    });
    plan.value = result.plan;
  });
}

function evidencePanel(taskId: string) {
  evidencePanels[taskId] ??= { open: false, mediaId: "", note: "" };
  return evidencePanels[taskId];
}

async function openEvidencePanel(taskId: string): Promise<void> {
  const panel = evidencePanel(taskId);
  panel.open = !panel.open;
  if (panel.open && !mediaOptions.value.length) {
    await run(async () => {
      const result = await apiFetch<{ data: MediaOption[] }>("/api/v1/media?status=READY&limit=100");
      mediaOptions.value = result.data;
    });
  }
}

async function attachEvidence(task: PlanTask): Promise<void> {
  const panel = evidencePanel(task.id);
  if (!panel.mediaId) return;
  await run(async () => {
    await apiFetch(`/api/v1/plans/${plan.value!.id}/tasks/${task.id}/evidence`, {
      method: "POST",
      body: JSON.stringify({ mediaId: panel.mediaId, note: panel.note || null }),
    });
    panel.mediaId = "";
    panel.note = "";
    panel.open = false;
    await refresh();
  });
}

async function removeEvidence(task: PlanTask, evidence: Evidence): Promise<void> {
  await run(async () => {
    await apiFetch(`/api/v1/plans/${plan.value!.id}/tasks/${task.id}/evidence/${evidence.id}`, { method: "DELETE" });
    await refresh();
  });
}

watch(
  () => route.params.id,
  () => {
    if (route.name === "plan-detail") void load();
  },
);
onMounted(load);
</script>

<template>
  <section class="page">
    <LoadingBlock v-if="loading" />
    <div v-else-if="error" class="alert">{{ error }} <button class="button small ghost" @click="load">重试</button></div>
    <template v-else-if="plan">
      <header class="page-header">
        <div>
          <div class="row wrap" style="gap: 8px; margin-bottom: 8px">
            <StatusBadge :value="plan.status" kind="plan" />
            <span v-if="plan.isTemplate" class="badge TEMPLATE">模板</span>
            <span v-if="plan.lockedAt" class="badge LOCKED">已锁定</span>
            <span class="badge">v{{ plan.versionNumber }}</span>
            <span v-if="!plan.chainHead" class="badge SKIPPED">历史版本</span>
          </div>
          <h1>{{ plan.title }}</h1>
          <p v-if="plan.description">{{ plan.description }}</p>
          <p class="muted">
            <span v-if="plan.instrument">{{ plan.instrument }} · </span>
            <span v-if="plan.goal">目标：{{ plan.goal.title }}（{{ plan.goal.targetValue }} {{ plan.goal.unit }}） · </span>
            <span v-if="plan.dueDate">截止 {{ plan.dueDate.slice(0, 10) }} · </span>
            进度复算于 {{ formatDateTime(plan.recomputedAt) }}
          </p>
        </div>
        <div class="row wrap end" style="gap: 8px">
          <button v-if="plan.status === 'DRAFT' && canExecute" class="button" @click="simpleAction(`/api/v1/plans/${plan.id}/activate`)">启用计划</button>
          <button v-if="plan.status === 'ACTIVE'" class="button" @click="simpleAction(`/api/v1/plans/${plan.id}/complete`, '确认整个计划已完成？')">完成计划</button>
          <button v-if="!plan.lockedAt" class="button secondary" @click="simpleAction(`/api/v1/plans/${plan.id}/lock`)">锁定</button>
          <button v-else-if="plan.chainHead" class="button secondary" @click="simpleAction(`/api/v1/plans/${plan.id}/unlock`)">解锁</button>
          <button v-if="plan.lockedAt" class="button" @click="revisePlan">改版（新版本）</button>
          <button class="button ghost" @click="copyPlan(false)">复制</button>
          <button v-if="!plan.isTemplate" class="button ghost" @click="copyPlan(true)">存为模板</button>
          <button class="button ghost" @click="simpleAction(`/api/v1/plans/${plan.id}/recompute`)">复算进度</button>
          <button v-if="plan.status !== 'ARCHIVED'" class="button ghost" @click="simpleAction(`/api/v1/plans/${plan.id}/archive`, '归档该计划？')">归档</button>
        </div>
      </header>

      <div v-if="actionError" class="alert" style="margin-bottom: 16px">{{ actionError }}</div>
      <div v-if="plan.lockedAt" class="alert info" style="margin-bottom: 16px">
        计划已锁定：结构只读。如需调整阶段或任务，点击“改版”创建 v{{ plan.versionNumber + 1 }} 新版本，执行进度会完整携带。
      </div>
      <div v-else-if="plan.isTemplate" class="alert info" style="margin-bottom: 16px">
        这是模板：复制为练习计划后即可执行，谱系会记录本次复制来源。
      </div>
      <div v-else-if="!plan.chainHead" class="alert warning" style="margin-bottom: 16px">
        这是历史版本，仅供回看。请切换到版本链中的最新版本继续执行。
      </div>

      <div class="card" style="margin-bottom: 18px">
        <div class="row between" style="margin-bottom: 10px">
          <strong>总进度 {{ plan.progressPct }}%</strong>
          <small class="muted">完成 {{ plan.doneTasks }} · 跳过 {{ plan.skippedTasks }} · 共 {{ plan.totalTasks }} 个任务</small>
        </div>
        <div class="progress-track"><div class="progress-fill" :style="{ width: `${plan.progressPct}%` }" /></div>
      </div>

      <div class="card flat" style="margin-bottom: 18px">
        <button class="button small ghost" @click="showLineage = !showLineage">
          {{ showLineage ? "收起谱系与版本" : "查看谱系与版本" }}
        </button>
        <div v-if="showLineage" class="stack" style="margin-top: 14px">
          <div>
            <strong>版本链</strong>
            <div class="chip-row">
              <button
                v-for="version in versions"
                :key="version.id"
                class="chip"
                :class="{ current: version.id === plan.id }"
                @click="router.push(`/plans/${version.id}`)"
              >
                v{{ version.versionNumber }}{{ version.lockedAt ? " · 锁" : "" }}{{ version.chainHead ? " · 最新" : "" }}
              </button>
            </div>
            <small v-if="plan.changeNote" class="muted">本版改版说明：{{ plan.changeNote }}</small>
          </div>
          <div v-if="ancestors.length">
            <strong>复制谱系（由近及远）</strong>
            <div class="chip-row">
              <button v-for="item in ancestors" :key="item.id" class="chip" @click="router.push(`/plans/${item.id}`)">
                {{ item.title }} · v{{ item.versionNumber }}
              </button>
            </div>
          </div>
          <div v-if="family.length > 1">
            <strong>同源计划（{{ family.length }}）</strong>
            <div class="chip-row">
              <button
                v-for="item in family"
                :key="item.id"
                class="chip"
                :class="{ current: item.id === plan.id }"
                @click="router.push(`/plans/${item.id}`)"
              >
                {{ item.title }} · {{ item.progressPct }}%
              </button>
            </div>
          </div>
          <small v-else-if="!ancestors.length" class="muted">该计划为原创计划，尚未被复制。</small>
        </div>
      </div>

      <div class="stack">
        <article v-for="phase in plan.phases" :key="phase.id" class="card stack">
          <div class="row between">
            <div>
              <h2 style="margin: 0">{{ phase.title }}</h2>
              <small v-if="phase.description" class="muted">{{ phase.description }}</small>
            </div>
            <div class="row" style="gap: 8px">
              <small class="muted">{{ phase.doneTasks }}/{{ phase.totalTasks }} · {{ phase.progressPct }}%</small>
              <template v-if="canEditStructure">
                <button class="button small ghost" @click="renamePhase(phase)">重命名</button>
                <button class="button small ghost" @click="removePhase(phase)">删除</button>
              </template>
            </div>
          </div>
          <div class="progress-track"><div class="progress-fill" :style="{ width: `${phase.progressPct}%` }" /></div>

          <div v-for="task in phase.tasks" :key="task.id" class="task" :class="{ done: task.status === 'DONE' }">
            <div class="task-main">
              <div class="row wrap" style="gap: 8px">
                <StatusBadge :value="task.status" kind="planTask" />
                <strong>{{ task.title }}</strong>
                <small v-if="task.evidenceRequirement !== 'NONE'" class="badge REQ">{{ evidenceRequirementLabels[task.evidenceRequirement] }}</small>
                <small v-if="task.estimateMinutes" class="muted">约 {{ task.estimateMinutes }} 分钟</small>
                <small v-if="task.dueDate" class="muted">截止 {{ task.dueDate.slice(0, 10) }}</small>
                <small v-if="task.linkedGoal" class="muted">关联目标：{{ task.linkedGoal.title }}</small>
              </div>
              <small v-if="task.description" class="muted">{{ task.description }}</small>
              <small v-if="task.selfReviewNote" class="muted">自评：{{ task.selfReviewNote }}</small>
              <div v-if="task.evidences.length" class="evidence-list">
                <span v-for="evidence in task.evidences" :key="evidence.id" class="chip evidence">
                  🎧 {{ evidence.media.originalName }}
                  <small v-if="evidence.media.durationMs">（{{ formatDuration(evidence.media.durationMs) }}）</small>
                  <small v-if="evidence.note">· {{ evidence.note }}</small>
                  <button v-if="canExecute" class="chip-remove" title="移除证据" @click="removeEvidence(task, evidence)">×</button>
                </span>
              </div>
              <div v-if="evidencePanels[task.id]?.open" class="row wrap" style="gap: 8px">
                <select v-model="evidencePanels[task.id]!.mediaId" style="min-width: 260px">
                  <option value="">选择已就绪音频</option>
                  <option v-for="media in mediaOptions" :key="media.id" :value="media.id">
                    {{ media.originalName }} · {{ media.session.title }}
                  </option>
                </select>
                <input v-model="evidencePanels[task.id]!.note" placeholder="证据备注（可留空）" maxlength="500" />
                <button class="button small" :disabled="!evidencePanels[task.id]!.mediaId" @click="attachEvidence(task)">关联</button>
              </div>
            </div>
            <div class="task-actions">
              <template v-if="canExecute">
                <button v-if="task.status === 'PENDING'" class="button small secondary" @click="setTaskStatus(task, 'IN_PROGRESS')">开始</button>
                <button v-if="['PENDING', 'IN_PROGRESS'].includes(task.status)" class="button small" @click="setTaskStatus(task, 'DONE')">完成</button>
                <button v-if="['PENDING', 'IN_PROGRESS'].includes(task.status)" class="button small ghost" @click="setTaskStatus(task, 'SKIPPED')">跳过</button>
                <button v-if="['DONE', 'SKIPPED'].includes(task.status)" class="button small ghost" @click="setTaskStatus(task, 'PENDING')">重置</button>
                <button class="button small ghost" @click="openEvidencePanel(task.id)">关联音频</button>
              </template>
              <button v-if="canEditStructure" class="button small ghost" @click="removeTask(task)">删除</button>
            </div>
          </div>

          <div v-if="canEditStructure">
            <button v-if="!taskForm(phase.id).open" class="button small secondary" @click="taskForm(phase.id).open = true">＋ 添加任务</button>
            <form v-else class="task-form" @submit.prevent="addTask(phase.id)">
              <input v-model="taskForm(phase.id).title" required maxlength="200" placeholder="任务标题，例如：17-24 小节慢练三遍" />
              <select v-model="taskForm(phase.id).evidenceRequirement">
                <option v-for="(label, value) in evidenceRequirementLabels" :key="value" :value="value">{{ label }}</option>
              </select>
              <input v-model="taskForm(phase.id).estimateMinutes" type="number" min="1" placeholder="预估分钟" style="width: 110px" />
              <select v-model="taskForm(phase.id).linkedGoalId">
                <option value="">不关联目标</option>
                <option v-for="goal in goals" :key="goal.id" :value="goal.id">{{ goal.title }}</option>
              </select>
              <button class="button small" type="submit">添加</button>
              <button class="button small ghost" type="button" @click="taskForm(phase.id).open = false">取消</button>
            </form>
          </div>
        </article>

        <div v-if="canEditStructure" class="card">
          <button v-if="!addingPhase" class="button secondary" @click="addingPhase = true">＋ 添加阶段</button>
          <form v-else class="row wrap" style="gap: 10px" @submit.prevent="addPhase">
            <input v-model="newPhase.title" required maxlength="160" placeholder="阶段标题，例如：第一周 · 慢速拆解" />
            <input v-model="newPhase.description" maxlength="2000" placeholder="阶段说明（可留空）" style="flex: 1; min-width: 220px" />
            <button class="button small" type="submit">添加阶段</button>
            <button class="button small ghost" type="button" @click="addingPhase = false">取消</button>
          </form>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.progress-track { height: 10px; border-radius: 999px; background: var(--surface-soft); overflow: hidden; }
.progress-fill { height: 100%; border-radius: 999px; background: var(--primary); transition: width 0.3s ease; }
.badge.TEMPLATE { background: #faead9; color: #9a5715; }
.badge.LOCKED { background: #f8e5e1; color: #93372d; }
.badge.REQ { background: #e2edf8; color: #275d8d; }
.task { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; padding: 13px 15px; border: 1px solid var(--line); border-radius: 12px; }
.task.done { background: var(--surface-soft); }
.task-main { display: grid; gap: 6px; min-width: 0; }
.task-actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; flex: 0 0 auto; }
.task-form { display: flex; flex-wrap: wrap; gap: 8px; }
.evidence-list { display: flex; flex-wrap: wrap; gap: 6px; }
.chip-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); font-size: .84rem; cursor: pointer; }
.chip.current { border-color: var(--primary); color: var(--primary-strong); font-weight: 700; }
.chip.evidence { cursor: default; }
.chip-remove { border: none; background: transparent; color: var(--danger); font-size: 1rem; line-height: 1; cursor: pointer; padding: 0 2px; }
@media (max-width: 720px) { .task { flex-direction: column; } .task-actions { justify-content: flex-start; } }
</style>
