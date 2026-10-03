import { z } from "zod";

/**
 * 练习计划编排器领域模块。
 *
 * 生命周期：DRAFT（结构可编辑）-> LOCKED（结构冻结，可挂载音频证据）-> 改版产生新版本（旧版本 ARCHIVED）。
 * 谱系：每个计划记录自己的来源（模板 / 计划副本 / 上一版本），可以一路向上回溯。
 * 进度：纯函数复算，只依赖任务结构与证据计数，不依赖任何缓存。
 */
export const PLAN_STATUSES = ["DRAFT", "LOCKED", "ARCHIVED"] as const;
export const PLAN_ORIGIN_TYPES = ["SCRATCH", "TEMPLATE", "PLAN_COPY", "REVISION"] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type PlanOriginType = (typeof PLAN_ORIGIN_TYPES)[number];

const requiredText = (label: string, max: number) =>
  z.string().trim().min(1, `${label}不能为空`).max(max, `${label}不能超过 ${max} 个字符`);
const optionalText = (max: number, label: string) =>
  z.string().trim().max(max, `${label}不能超过 ${max} 个字符`).optional().nullable();

export const MAX_PLAN_STAGES = 50;
export const MAX_STAGE_TASKS = 100;

export const planTaskInputSchema = z.object({
  /** 结构整体替换时用于保留已有任务（及其证据）；缺省表示新建任务 */
  id: z.string().uuid().optional(),
  title: requiredText("任务标题", 160),
  detail: optionalText(1000, "任务说明"),
  requiredEvidence: z.coerce.number().int().min(1, "至少需要一个音频证据").max(20, "单个任务最多 20 个音频证据").default(1),
  weight: z.coerce.number().positive("任务权重必须大于 0").max(1000, "任务权重不能超过 1000").default(1),
});

export const planStageInputSchema = z.object({
  id: z.string().uuid().optional(),
  title: requiredText("阶段标题", 120),
  tasks: z.array(planTaskInputSchema).max(MAX_STAGE_TASKS, `单个阶段最多 ${MAX_STAGE_TASKS} 个任务`).default([]),
});

export const planStructureSchema = z
  .object({
    revision: z.coerce.number().int().nonnegative(),
    stages: z.array(planStageInputSchema).max(MAX_PLAN_STAGES, `最多 ${MAX_PLAN_STAGES} 个阶段`),
  })
  .superRefine((value, ctx) => {
    const stageIds = new Set<string>();
    const taskIds = new Set<string>();
    value.stages.forEach((stage, stageIndex) => {
      if (stage.id) {
        if (stageIds.has(stage.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["stages", stageIndex, "id"], message: "阶段 id 重复" });
        }
        stageIds.add(stage.id);
      }
      stage.tasks.forEach((task, taskIndex) => {
        if (task.id) {
          if (taskIds.has(task.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["stages", stageIndex, "tasks", taskIndex, "id"],
              message: "任务 id 重复",
            });
          }
          taskIds.add(task.id);
        }
      });
    });
  });

export const planCreateSchema = z.object({
  goal: requiredText("目标", 300),
  stages: z.array(planStageInputSchema).max(MAX_PLAN_STAGES, `最多 ${MAX_PLAN_STAGES} 个阶段`).default([]),
});

export const planUpdateSchema = z.object({
  revision: z.coerce.number().int().nonnegative(),
  goal: requiredText("目标", 300).optional(),
});

export const planListQuerySchema = z.object({
  status: z.enum(PLAN_STATUSES).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const planTemplateCreateSchema = z.object({
  name: requiredText("模板名称", 120),
  goal: requiredText("目标", 300),
  description: optionalText(2000, "模板说明"),
  stages: z.array(planStageInputSchema).min(1, "模板至少包含一个阶段").max(MAX_PLAN_STAGES, `最多 ${MAX_PLAN_STAGES} 个阶段`),
});

export const planTemplateInstantiateSchema = z.object({
  goal: requiredText("目标", 300).optional(),
});

export const planCopySchema = z.object({
  goal: requiredText("目标", 300).optional(),
});

export const planSaveAsTemplateSchema = z.object({
  name: requiredText("模板名称", 120),
  description: optionalText(2000, "模板说明"),
});

export const planEvidenceCreateSchema = z.object({
  mediaId: z.string().uuid(),
  note: optionalText(500, "证据备注"),
});

export type PlanTaskInput = z.infer<typeof planTaskInputSchema>;
export type PlanStageInput = z.infer<typeof planStageInputSchema>;
export type PlanStructureInput = z.infer<typeof planStructureSchema>;
export type PlanCreateInput = z.infer<typeof planCreateSchema>;
export type PlanUpdateInput = z.infer<typeof planUpdateSchema>;
export type PlanListQuery = z.infer<typeof planListQuerySchema>;
export type PlanTemplateCreateInput = z.infer<typeof planTemplateCreateSchema>;
export type PlanTemplateInstantiateInput = z.infer<typeof planTemplateInstantiateSchema>;
export type PlanCopyInput = z.infer<typeof planCopySchema>;
export type PlanSaveAsTemplateInput = z.infer<typeof planSaveAsTemplateSchema>;
export type PlanEvidenceCreateInput = z.infer<typeof planEvidenceCreateSchema>;

/* ---------- 状态机守卫 ---------- */

/** 仅草稿允许编辑结构（目标、阶段、任务） */
export function canEditPlanStructure(status: PlanStatus): boolean {
  return status === "DRAFT";
}

/** 仅草稿可以锁定 */
export function canLockPlan(status: PlanStatus): boolean {
  return status === "DRAFT";
}

/** 仅已锁定计划可以改版（改版会新建版本并归档旧版本） */
export function canRevisePlan(status: PlanStatus): boolean {
  return status === "LOCKED";
}

/** 仅已锁定计划处于执行期，允许挂载或移除音频证据 */
export function canAttachPlanEvidence(status: PlanStatus): boolean {
  return status === "LOCKED";
}

/* ---------- 锁定前置检查 ---------- */

export interface PlanLockCheckStage {
  title: string;
  order: number;
  tasks: readonly unknown[];
}

/**
 * 返回所有阻止锁定的问题（空数组表示可以锁定）。
 * 与 describeMissingReview 一致：一次返回全部缺失项，而不是笼统失败。
 */
export function describePlanLockBlockers(stages: readonly PlanLockCheckStage[]): string[] {
  const blockers: string[] = [];
  if (stages.length === 0) blockers.push("计划至少包含一个阶段");
  for (const stage of [...stages].sort((a, b) => a.order - b.order)) {
    if (stage.tasks.length === 0) blockers.push(`阶段「${stage.title}」至少需要一个任务`);
  }
  return blockers;
}

/* ---------- 进度复算 ---------- */

export interface PlanTaskSnapshot {
  id: string;
  title: string;
  requiredEvidence: number;
  weight: number;
}

export interface PlanStageSnapshot {
  id: string;
  title: string;
  order: number;
  tasks: readonly PlanTaskSnapshot[];
}

export interface PlanTaskProgressView {
  taskId: string;
  title: string;
  requiredEvidence: number;
  evidenceCount: number;
  done: boolean;
  weight: number;
}

export interface PlanStageProgressView {
  stageId: string;
  title: string;
  order: number;
  tasks: PlanTaskProgressView[];
  totalTasks: number;
  doneTasks: number;
  totalWeight: number;
  doneWeight: number;
  ratio: number;
}

export interface PlanProgressReport {
  stages: PlanStageProgressView[];
  totalTasks: number;
  doneTasks: number;
  totalWeight: number;
  doneWeight: number;
  ratio: number;
  percent: number;
  complete: boolean;
}

/**
 * 进度复算：纯函数，输入任务结构快照与每个任务的证据计数。
 * 任务完成 ⇔ 证据数 >= requiredEvidence；阶段与整体按任务权重加权汇总。
 * 同样的输入永远得到同样的结果，因此任何时候都可以用最新数据整体重算。
 */
export function computePlanProgress(
  stages: readonly PlanStageSnapshot[],
  evidenceCountByTask: ReadonlyMap<string, number>,
): PlanProgressReport {
  const stageViews: PlanStageProgressView[] = [];
  let totalTasks = 0;
  let doneTasks = 0;
  let totalWeight = 0;
  let doneWeight = 0;

  for (const stage of [...stages].sort((a, b) => a.order - b.order)) {
    const taskViews: PlanTaskProgressView[] = [];
    let stageTotalWeight = 0;
    let stageDoneWeight = 0;
    let stageDoneTasks = 0;

    for (const task of stage.tasks) {
      const evidenceCount = evidenceCountByTask.get(task.id) ?? 0;
      const done = evidenceCount >= task.requiredEvidence;
      taskViews.push({
        taskId: task.id,
        title: task.title,
        requiredEvidence: task.requiredEvidence,
        evidenceCount,
        done,
        weight: task.weight,
      });
      stageTotalWeight += task.weight;
      if (done) {
        stageDoneWeight += task.weight;
        stageDoneTasks += 1;
      }
    }

    stageViews.push({
      stageId: stage.id,
      title: stage.title,
      order: stage.order,
      tasks: taskViews,
      totalTasks: taskViews.length,
      doneTasks: stageDoneTasks,
      totalWeight: stageTotalWeight,
      doneWeight: stageDoneWeight,
      ratio: stageTotalWeight > 0 ? stageDoneWeight / stageTotalWeight : 0,
    });

    totalTasks += taskViews.length;
    doneTasks += stageDoneTasks;
    totalWeight += stageTotalWeight;
    doneWeight += stageDoneWeight;
  }

  const ratio = totalWeight > 0 ? doneWeight / totalWeight : 0;
  return {
    stages: stageViews,
    totalTasks,
    doneTasks,
    totalWeight,
    doneWeight,
    ratio,
    percent: Math.round(ratio * 1000) / 10,
    complete: totalTasks > 0 && doneTasks === totalTasks,
  };
}

/* ---------- 谱系 ---------- */

export interface PlanLineageNode {
  kind: "PLAN" | "TEMPLATE";
  id: string;
  /** 计划为目标描述，模板为模板名 */
  label: string;
  /** 仅计划节点有版本与状态 */
  planVersion: number | null;
  planStatus: PlanStatus | null;
  /** 该节点如何产生；模板节点为 null（模板来源体现在链路的下一个节点上） */
  originType: PlanOriginType | null;
  /** 来源记录存在但实体已不可见（如已删除）时为 true */
  missing: boolean;
}
