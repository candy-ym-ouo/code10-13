import {
  canAttachPlanEvidence,
  canEditPlanStructure,
  canLockPlan,
  canRevisePlan,
  computePlanProgress,
  describePlanLockBlockers,
  type PlanCopyInput,
  type PlanCreateInput,
  type PlanEvidenceCreateInput,
  type PlanLineageNode,
  type PlanListQuery,
  type PlanProgressReport,
  type PlanSaveAsTemplateInput,
  type PlanStageInput,
  type PlanStageSnapshot,
  type PlanStructureInput,
  type PlanTemplateCreateInput,
  type PlanTemplateInstantiateInput,
  type PlanUpdateInput,
} from "@practice/contracts";
import type { PracticePlan } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError, notFound } from "../lib/errors.js";

const taskOrderBy = { order: "asc" as const };
const stageOrderBy = { order: "asc" as const };

export const planDetailInclude = {
  stages: {
    orderBy: stageOrderBy,
    include: {
      tasks: {
        orderBy: taskOrderBy,
        include: {
          evidences: {
            orderBy: { createdAt: "asc" as const },
            include: {
              media: { select: { id: true, originalName: true, status: true, durationMs: true } },
              inheritedFrom: { select: { id: true, planId: true } },
            },
          },
        },
      },
    },
  },
  originTemplate: { select: { id: true, name: true } },
  originPlan: { select: { id: true, goal: true, version: true, status: true } },
} as const;

const planStructureInclude = {
  stages: { orderBy: stageOrderBy, include: { tasks: { orderBy: taskOrderBy } } },
} as const;

const templateInclude = {
  stages: { orderBy: stageOrderBy, include: { tasks: { orderBy: taskOrderBy } } },
  sourcePlan: { select: { id: true, goal: true, version: true } },
} as const;

function invalidState(message: string): AppError {
  return new AppError(409, "INVALID_PLAN_STATE", message);
}

async function findPlanOrThrow(userId: string, planId: string) {
  const plan = await prisma.practicePlan.findFirst({ where: { id: planId, userId }, include: planDetailInclude });
  if (!plan) throw notFound();
  return plan;
}

function stageCreateInputs(stages: PlanStageInput[]) {
  return stages.map((stage, stageIndex) => ({
    title: stage.title,
    order: stageIndex + 1,
    tasks: {
      create: stage.tasks.map((task, taskIndex) => ({
        title: task.title,
        detail: task.detail ?? null,
        requiredEvidence: task.requiredEvidence,
        weight: task.weight,
        order: taskIndex + 1,
      })),
    },
  }));
}

/* ---------- 计划：创建与编辑（仅草稿） ---------- */

export async function createPlan(userId: string, input: PlanCreateInput) {
  return prisma.practicePlan.create({
    data: {
      userId,
      goal: input.goal,
      originType: "SCRATCH",
      stages: { create: stageCreateInputs(input.stages) },
    },
    include: planDetailInclude,
  });
}

export async function listPlans(userId: string, query: PlanListQuery) {
  const data = await prisma.practicePlan.findMany({
    where: { userId, ...(query.status ? { status: query.status } : {}) },
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    include: planStructureInclude,
  });
  const hasMore = data.length > query.limit;
  const items = hasMore ? data.slice(0, query.limit) : data;

  // 列表项直接附进度摘要：一次 groupBy 取回本页全部计划的证据计数后逐个复算
  const counts = await prisma.planTaskEvidence.groupBy({
    by: ["planId", "taskId"],
    where: { planId: { in: items.map((plan) => plan.id) } },
    _count: { _all: true },
  });
  const countsByPlan = new Map<string, Map<string, number>>();
  for (const row of counts) {
    let taskCounts = countsByPlan.get(row.planId);
    if (!taskCounts) countsByPlan.set(row.planId, (taskCounts = new Map()));
    taskCounts.set(row.taskId, row._count._all);
  }

  return {
    data: items.map((plan) => {
      const { stages, ...rest } = plan;
      const report = computePlanProgress(toStageSnapshots(stages), countsByPlan.get(plan.id) ?? new Map());
      return {
        ...rest,
        progress: {
          totalTasks: report.totalTasks,
          doneTasks: report.doneTasks,
          ratio: report.ratio,
          percent: report.percent,
          complete: report.complete,
        },
      };
    }),
    nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
  };
}

export async function getPlan(userId: string, planId: string) {
  return findPlanOrThrow(userId, planId);
}

export async function updatePlan(userId: string, planId: string, input: PlanUpdateInput) {
  const plan = await prisma.practicePlan.findFirst({ where: { id: planId, userId }, select: { id: true, status: true } });
  if (!plan) throw notFound();
  if (!canEditPlanStructure(plan.status)) {
    throw invalidState("只有草稿状态的计划可以修改；已锁定计划请先改版");
  }
  const updated = await prisma.practicePlan.updateMany({
    where: { id: planId, userId, revision: input.revision },
    data: {
      ...(input.goal === undefined ? {} : { goal: input.goal }),
      revision: { increment: 1 },
    },
  });
  if (updated.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "计划已在其他窗口被修改");
  return findPlanOrThrow(userId, planId);
}

/**
 * 结构整体替换（仅草稿，事务内乐观锁）。
 * 输入中携带已有阶段/任务 id 表示保留（其证据随之保留），未携带的 id 将被删除并级联清理证据。
 */
export async function replacePlanStructure(userId: string, planId: string, input: PlanStructureInput) {
  const plan = await prisma.practicePlan.findFirst({
    where: { id: planId, userId },
    include: { stages: { include: { tasks: { select: { id: true } } } } },
  });
  if (!plan) throw notFound();
  if (!canEditPlanStructure(plan.status)) {
    throw invalidState("只有草稿状态的计划可以调整结构；已锁定计划请先改版");
  }

  // 归属校验：引用的阶段/任务必须属于当前计划，且任务必须留在原阶段（移动 = 删除后重建）
  const stageById = new Map(plan.stages.map((stage) => [stage.id, stage]));
  for (const stageInput of input.stages) {
    if (!stageInput.id) {
      if (stageInput.tasks.some((task) => task.id)) {
        throw new AppError(400, "VALIDATION_ERROR", "新阶段不能引用已有任务");
      }
      continue;
    }
    const current = stageById.get(stageInput.id);
    if (!current) throw new AppError(400, "VALIDATION_ERROR", "阶段不属于该计划");
    const taskIds = new Set(current.tasks.map((task) => task.id));
    for (const task of stageInput.tasks) {
      if (task.id && !taskIds.has(task.id)) throw new AppError(400, "VALIDATION_ERROR", "任务不属于该阶段");
    }
  }

  await prisma.$transaction(async (tx) => {
    const guard = await tx.practicePlan.updateMany({
      where: { id: planId, userId, revision: input.revision, status: "DRAFT" },
      data: { revision: { increment: 1 } },
    });
    if (guard.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "计划已在其他窗口被修改");

    const keepStageIds = input.stages.map((stage) => stage.id).filter((id): id is string => Boolean(id));
    await tx.planStage.deleteMany({ where: { planId, id: { notIn: keepStageIds } } });

    for (const [stageIndex, stageInput] of input.stages.entries()) {
      let stageId: string;
      if (stageInput.id) {
        await tx.planStage.update({ where: { id: stageInput.id }, data: { title: stageInput.title, order: stageIndex + 1 } });
        stageId = stageInput.id;
      } else {
        const created = await tx.planStage.create({ data: { planId, title: stageInput.title, order: stageIndex + 1 } });
        stageId = created.id;
      }

      const keepTaskIds = stageInput.tasks.map((task) => task.id).filter((id): id is string => Boolean(id));
      await tx.planTask.deleteMany({ where: { stageId, id: { notIn: keepTaskIds } } });
      for (const [taskIndex, taskInput] of stageInput.tasks.entries()) {
        const data = {
          title: taskInput.title,
          detail: taskInput.detail ?? null,
          requiredEvidence: taskInput.requiredEvidence,
          weight: taskInput.weight,
          order: taskIndex + 1,
        };
        if (taskInput.id) {
          await tx.planTask.update({ where: { id: taskInput.id }, data });
        } else {
          await tx.planTask.create({ data: { ...data, stageId } });
        }
      }
    }
  });
  return findPlanOrThrow(userId, planId);
}

/* ---------- 锁定与改版 ---------- */

export async function lockPlan(userId: string, planId: string) {
  const plan = await prisma.practicePlan.findFirst({
    where: { id: planId, userId },
    include: { stages: { include: { tasks: { select: { id: true } } } } },
  });
  if (!plan) throw notFound();
  if (!canLockPlan(plan.status)) throw invalidState("只有草稿状态的计划可以锁定");
  const blockers = describePlanLockBlockers(plan.stages);
  if (blockers.length > 0) throw new AppError(409, "PLAN_LOCK_BLOCKED", "计划结构不完整，无法锁定", blockers);
  const locked = await prisma.practicePlan.updateMany({
    where: { id: planId, userId, status: "DRAFT" },
    data: { status: "LOCKED", lockedAt: new Date(), revision: { increment: 1 } },
  });
  if (locked.count !== 1) throw invalidState("计划状态已变化，请刷新后重试");
  return findPlanOrThrow(userId, planId);
}

/**
 * 改版：仅已锁定计划。事务内归档旧版本（成为不可变快照），
 * 以 version+1 新建草稿版本，深拷贝结构并记录任务级谱系，
 * 证据克隆到新任务上（inheritedFromId 指回旧证据），进度因此延续。
 */
export async function revisePlan(userId: string, planId: string) {
  const plan = await prisma.practicePlan.findFirst({
    where: { id: planId, userId },
    include: { stages: { orderBy: stageOrderBy, include: { tasks: { orderBy: taskOrderBy, include: { evidences: true } } } } },
  });
  if (!plan) throw notFound();
  if (!canRevisePlan(plan.status)) throw invalidState("只有已锁定的计划可以改版；草稿请直接修改");

  const newPlan = await prisma.$transaction(async (tx) => {
    const archived = await tx.practicePlan.updateMany({
      where: { id: planId, userId, status: "LOCKED" },
      data: { status: "ARCHIVED", archivedAt: new Date(), revision: { increment: 1 } },
    });
    if (archived.count !== 1) throw invalidState("计划状态已变化，请刷新后重试");

    const created = await tx.practicePlan.create({
      data: {
        userId,
        goal: plan.goal,
        status: "DRAFT",
        version: plan.version + 1,
        originType: "REVISION",
        originPlanId: plan.id,
        originPlanVersion: plan.version,
      },
    });
    for (const stage of plan.stages) {
      const newStage = await tx.planStage.create({
        data: { planId: created.id, title: stage.title, order: stage.order, derivedFromStageId: stage.id },
      });
      for (const task of stage.tasks) {
        const newTask = await tx.planTask.create({
          data: {
            stageId: newStage.id,
            title: task.title,
            detail: task.detail,
            requiredEvidence: task.requiredEvidence,
            weight: task.weight,
            order: task.order,
            derivedFromTaskId: task.id,
          },
        });
        for (const evidence of task.evidences) {
          await tx.planTaskEvidence.create({
            data: {
              userId,
              planId: created.id,
              taskId: newTask.id,
              mediaId: evidence.mediaId,
              note: evidence.note,
              inheritedFromId: evidence.id,
            },
          });
        }
      }
    }
    return created;
  });
  return findPlanOrThrow(userId, newPlan.id);
}

/* ---------- 复制与模板（谱系） ---------- */

/** 复制计划：全新执行实例（v1 草稿），保留谱系指向来源，不带证据 */
export async function copyPlan(userId: string, planId: string, input: PlanCopyInput) {
  const plan = await prisma.practicePlan.findFirst({
    where: { id: planId, userId },
    include: { stages: { orderBy: stageOrderBy, include: { tasks: { orderBy: taskOrderBy } } } },
  });
  if (!plan) throw notFound();
  return prisma.practicePlan.create({
    data: {
      userId,
      goal: input.goal ?? plan.goal,
      version: 1,
      originType: "PLAN_COPY",
      originPlanId: plan.id,
      originPlanVersion: plan.version,
      stages: {
        create: plan.stages.map((stage, stageIndex) => ({
          title: stage.title,
          order: stageIndex + 1,
          derivedFromStageId: stage.id,
          tasks: {
            create: stage.tasks.map((task, taskIndex) => ({
              title: task.title,
              detail: task.detail,
              requiredEvidence: task.requiredEvidence,
              weight: task.weight,
              order: taskIndex + 1,
              derivedFromTaskId: task.id,
            })),
          },
        })),
      },
    },
    include: planDetailInclude,
  });
}

export async function createTemplate(userId: string, input: PlanTemplateCreateInput) {
  return prisma.planTemplate.create({
    data: {
      userId,
      name: input.name,
      goal: input.goal,
      description: input.description ?? null,
      stages: { create: stageCreateInputs(input.stages) },
    },
    include: templateInclude,
  });
}

export async function listTemplates(userId: string) {
  const data = await prisma.planTemplate.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: templateInclude,
  });
  return { data };
}

export async function getTemplate(userId: string, templateId: string) {
  const template = await prisma.planTemplate.findFirst({ where: { id: templateId, userId }, include: templateInclude });
  if (!template) throw notFound();
  return template;
}

/** 实例化模板：生成 v1 草稿计划，谱系指向模板，任务级 derivedFrom 指向模板任务 */
export async function instantiateTemplate(userId: string, templateId: string, input: PlanTemplateInstantiateInput) {
  const template = await prisma.planTemplate.findFirst({
    where: { id: templateId, userId },
    include: { stages: { orderBy: stageOrderBy, include: { tasks: { orderBy: taskOrderBy } } } },
  });
  if (!template) throw notFound();
  return prisma.practicePlan.create({
    data: {
      userId,
      goal: input.goal ?? template.goal,
      version: 1,
      originType: "TEMPLATE",
      originTemplateId: template.id,
      stages: {
        create: template.stages.map((stage, stageIndex) => ({
          title: stage.title,
          order: stageIndex + 1,
          derivedFromStageId: stage.id,
          tasks: {
            create: stage.tasks.map((task, taskIndex) => ({
              title: task.title,
              detail: task.detail,
              requiredEvidence: task.requiredEvidence,
              weight: task.weight,
              order: taskIndex + 1,
              derivedFromTaskId: task.id,
            })),
          },
        })),
      },
    },
    include: planDetailInclude,
  });
}

/** 把计划当前结构另存为模板，模板谱系（sourcePlanId）指回该计划 */
export async function savePlanAsTemplate(userId: string, planId: string, input: PlanSaveAsTemplateInput) {
  const plan = await prisma.practicePlan.findFirst({
    where: { id: planId, userId },
    include: { stages: { orderBy: stageOrderBy, include: { tasks: { orderBy: taskOrderBy } } } },
  });
  if (!plan) throw notFound();
  if (plan.stages.length === 0) throw new AppError(400, "VALIDATION_ERROR", "空计划无法保存为模板");
  return prisma.planTemplate.create({
    data: {
      userId,
      name: input.name,
      goal: plan.goal,
      description: input.description ?? null,
      sourcePlanId: plan.id,
      stages: {
        create: plan.stages.map((stage, stageIndex) => ({
          title: stage.title,
          order: stageIndex + 1,
          tasks: {
            create: stage.tasks.map((task, taskIndex) => ({
              title: task.title,
              detail: task.detail,
              requiredEvidence: task.requiredEvidence,
              weight: task.weight,
              order: taskIndex + 1,
            })),
          },
        })),
      },
    },
    include: templateInclude,
  });
}

/* ---------- 音频证据 ---------- */

export async function addEvidence(userId: string, planId: string, taskId: string, input: PlanEvidenceCreateInput) {
  const plan = await prisma.practicePlan.findFirst({ where: { id: planId, userId }, select: { id: true, status: true } });
  if (!plan) throw notFound();
  if (!canAttachPlanEvidence(plan.status)) {
    throw invalidState("只有已锁定（执行中）的计划可以挂载音频证据；如需调整结构请先改版");
  }
  const task = await prisma.planTask.findFirst({ where: { id: taskId, stage: { planId } }, select: { id: true } });
  if (!task) throw new AppError(400, "VALIDATION_ERROR", "任务不属于该计划");
  const media = await prisma.mediaAsset.findFirst({
    where: { id: input.mediaId, userId, status: "READY" },
    select: { id: true },
  });
  if (!media) throw new AppError(400, "VALIDATION_ERROR", "证据音频必须已就绪");
  return prisma.planTaskEvidence.create({
    data: { userId, planId, taskId, mediaId: input.mediaId, note: input.note ?? null },
    include: { media: { select: { id: true, originalName: true, status: true, durationMs: true } } },
  });
}

export async function removeEvidence(userId: string, planId: string, evidenceId: string) {
  const plan = await prisma.practicePlan.findFirst({ where: { id: planId, userId }, select: { id: true, status: true } });
  if (!plan) throw notFound();
  if (!canAttachPlanEvidence(plan.status)) {
    throw invalidState("只有已锁定（执行中）的计划可以移除音频证据");
  }
  const deleted = await prisma.planTaskEvidence.deleteMany({ where: { id: evidenceId, planId, userId } });
  if (deleted.count !== 1) throw notFound();
}

/* ---------- 进度复算 ---------- */

function toStageSnapshots(stages: Array<{ id: string; title: string; order: number; tasks: Array<{ id: string; title: string; requiredEvidence: number; weight: number }> }>): PlanStageSnapshot[] {
  return stages.map((stage) => ({
    id: stage.id,
    title: stage.title,
    order: stage.order,
    tasks: stage.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      requiredEvidence: task.requiredEvidence,
      weight: task.weight,
    })),
  }));
}

export interface PlanProgressResponse extends PlanProgressReport {
  planId: string;
  planVersion: number;
  computedAt: string;
}

/** 进度可复算：每次读取都用最新的任务结构与证据计数整体重算，不依赖缓存 */
export async function getPlanProgress(userId: string, planId: string): Promise<PlanProgressResponse> {
  const plan = await prisma.practicePlan.findFirst({
    where: { id: planId, userId },
    include: { stages: { orderBy: stageOrderBy, include: { tasks: { orderBy: taskOrderBy } } } },
  });
  if (!plan) throw notFound();
  const counts = await prisma.planTaskEvidence.groupBy({
    by: ["taskId"],
    where: { planId: plan.id },
    _count: { _all: true },
  });
  const report = computePlanProgress(
    toStageSnapshots(plan.stages),
    new Map(counts.map((row) => [row.taskId, row._count._all])),
  );
  return { planId: plan.id, planVersion: plan.version, computedAt: new Date().toISOString(), ...report };
}

/* ---------- 谱系回溯 ---------- */

/**
 * 从当前计划一路向上回溯：改版/复制的来源计划 -> 实例化来源模板 -> 模板的来源计划……
 * 返回从近到远的节点列表；带 visited 防御，异常数据成环时也不会死循环。
 */
export async function getPlanLineage(userId: string, planId: string): Promise<PlanLineageNode[]> {
  const nodes: PlanLineageNode[] = [];
  const seen = new Set<string>();
  const first = await prisma.practicePlan.findFirst({ where: { id: planId, userId } });
  if (!first) throw notFound();
  let current: PracticePlan = first;

  while (true) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    nodes.push({
      kind: "PLAN",
      id: current.id,
      label: current.goal,
      planVersion: current.version,
      planStatus: current.status,
      originType: current.originType,
      missing: false,
    });

    if ((current.originType === "REVISION" || current.originType === "PLAN_COPY") && current.originPlanId) {
      const parent = await prisma.practicePlan.findFirst({ where: { id: current.originPlanId, userId } });
      if (!parent) {
        nodes.push({
          kind: "PLAN",
          id: current.originPlanId,
          label: "",
          planVersion: current.originPlanVersion,
          planStatus: null,
          originType: null,
          missing: true,
        });
        break;
      }
      current = parent;
      continue;
    }

    if (current.originType === "TEMPLATE" && current.originTemplateId) {
      const template = await prisma.planTemplate.findFirst({ where: { id: current.originTemplateId, userId } });
      if (!template) {
        nodes.push({
          kind: "TEMPLATE",
          id: current.originTemplateId,
          label: "",
          planVersion: null,
          planStatus: null,
          originType: null,
          missing: true,
        });
        break;
      }
      nodes.push({
        kind: "TEMPLATE",
        id: template.id,
        label: template.name,
        planVersion: null,
        planStatus: null,
        originType: null,
        missing: false,
      });
      if (template.sourcePlanId) {
        const source = await prisma.practicePlan.findFirst({ where: { id: template.sourcePlanId, userId } });
        if (source) {
          current = source;
          continue;
        }
      }
    }
    break;
  }
  return nodes;
}
