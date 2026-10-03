import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type PracticePlan } from "@prisma/client";
import { computeProgressCounts } from "@practice/contracts";
import { AppError, notFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

type DbClient = Prisma.TransactionClient | PrismaClient;

export const planSummarySelect = {
  id: true,
  title: true,
  status: true,
  isTemplate: true,
  versionChainId: true,
  versionNumber: true,
  previousVersionId: true,
  chainHead: true,
  lockedAt: true,
  changeNote: true,
  copiedFromId: true,
  rootAncestorId: true,
  totalTasks: true,
  doneTasks: true,
  skippedTasks: true,
  progressPct: true,
  recomputedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PracticePlanSelect;

export const planDetailInclude = {
  goal: { select: { id: true, title: true, status: true, targetValue: true, unit: true } },
  phases: {
    orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
    include: {
      tasks: {
        orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
        include: {
          linkedGoal: { select: { id: true, title: true, status: true } },
          evidences: {
            orderBy: { createdAt: "asc" },
            include: {
              media: { select: { id: true, sessionId: true, originalName: true, status: true, durationMs: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.PracticePlanInclude;

export async function getPlanForUser(userId: string, planId: string) {
  const plan = await prisma.practicePlan.findFirst({ where: { id: planId, userId } });
  if (!plan) throw notFound();
  return plan;
}

export async function getPlanDetail(userId: string, planId: string) {
  const plan = await prisma.practicePlan.findFirst({
    where: { id: planId, userId },
    include: planDetailInclude,
  });
  if (!plan) throw notFound();
  return plan;
}

/** 锁定只冻结结构（元信息、阶段、任务定义），执行数据（任务状态、证据）仍可在链首版本上推进。 */
export function assertPlanStructureMutable(plan: PracticePlan): void {
  if (plan.lockedAt) {
    throw new AppError(409, "PLAN_LOCKED", "计划已锁定，请通过改版创建新版本后再修改");
  }
}

/** 执行入口只面向非模板的链首版本：模板先复制，旧版本已封存为历史。 */
export function assertPlanExecutable(plan: PracticePlan): void {
  if (plan.isTemplate) {
    throw new AppError(409, "PLAN_TEMPLATE_NOT_EXECUTABLE", "模板不能直接执行，请先复制为练习计划");
  }
  if (!plan.chainHead) {
    throw new AppError(409, "PLAN_VERSION_SUPERSEDED", "该版本已有新版本，请切换到最新版本执行");
  }
}

/**
 * 进度复算：以任务状态为唯一事实来源，重算每个阶段与整个计划的聚合并落库。
 * 任何任务变更后都会调用，也可通过 /recompute 端点随时手动触发。
 */
export async function recomputePlanProgress(client: DbClient, planId: string) {
  const [tasks, phases] = await Promise.all([
    client.planTask.findMany({ where: { planId }, select: { phaseId: true, status: true } }),
    client.planPhase.findMany({ where: { planId }, select: { id: true } }),
  ]);
  for (const phase of phases) {
    const counts = computeProgressCounts(
      tasks.filter((task) => task.phaseId === phase.id).map((task) => task.status),
    );
    await client.planPhase.update({
      where: { id: phase.id },
      data: {
        totalTasks: counts.total,
        doneTasks: counts.done,
        skippedTasks: counts.skipped,
        progressPct: counts.percent,
      },
    });
  }
  const planCounts = computeProgressCounts(tasks.map((task) => task.status));
  const plan = await client.practicePlan.update({
    where: { id: planId },
    data: {
      totalTasks: planCounts.total,
      doneTasks: planCounts.done,
      skippedTasks: planCounts.skipped,
      progressPct: planCounts.percent,
      recomputedAt: new Date(),
    },
  });
  return planCounts;
}

interface CopyStructureOptions {
  sourcePlanId: string;
  targetPlanId: string;
  userId: string;
  /** 改版为 true：携带任务状态与证据；模板复制为 false：全新执行。 */
  carryExecution: boolean;
}

export async function copyPlanStructure(client: DbClient, options: CopyStructureOptions): Promise<void> {
  const phases = await client.planPhase.findMany({
    where: { planId: options.sourcePlanId },
    orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
    include: {
      tasks: {
        orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
        include: { evidences: true },
      },
    },
  });
  for (const phase of phases) {
    const newPhase = await client.planPhase.create({
      data: {
        planId: options.targetPlanId,
        userId: options.userId,
        title: phase.title,
        description: phase.description,
        orderIndex: phase.orderIndex,
      },
    });
    for (const task of phase.tasks) {
      const newTask = await client.planTask.create({
        data: {
          planId: options.targetPlanId,
          phaseId: newPhase.id,
          userId: options.userId,
          title: task.title,
          description: task.description,
          orderIndex: task.orderIndex,
          evidenceRequirement: task.evidenceRequirement,
          estimateMinutes: task.estimateMinutes,
          dueDate: task.dueDate,
          linkedGoalId: task.linkedGoalId,
          status: options.carryExecution ? task.status : "PENDING",
          selfReviewNote: options.carryExecution ? task.selfReviewNote : null,
          completedAt: options.carryExecution ? task.completedAt : null,
        },
      });
      if (options.carryExecution) {
        for (const evidence of task.evidences) {
          await client.planTaskEvidence.create({
            data: {
              taskId: newTask.id,
              planId: options.targetPlanId,
              userId: options.userId,
              mediaId: evidence.mediaId,
              note: evidence.note,
            },
          });
        }
      }
    }
  }
}

/** 谱系：沿 copiedFromId 向上走到根，再按 rootAncestorId 捞出整个复制家族。 */
export async function getPlanLineage(userId: string, plan: PracticePlan) {
  const ancestors: Array<Prisma.PracticePlanGetPayload<{ select: typeof planSummarySelect }>> = [];
  const seen = new Set<string>([plan.id]);
  let cursor = plan.copiedFromId;
  while (cursor && ancestors.length < 20 && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = await prisma.practicePlan.findFirst({
      where: { id: cursor, userId },
      select: planSummarySelect,
    });
    if (!parent) break;
    ancestors.push(parent);
    cursor = parent.copiedFromId;
  }
  const rootId = plan.rootAncestorId ?? plan.id;
  const family = await prisma.practicePlan.findMany({
    where: { userId, OR: [{ rootAncestorId: rootId }, { id: rootId }] },
    orderBy: [{ createdAt: "asc" }],
    select: planSummarySelect,
  });
  return { ancestors, family };
}

export async function getPlanVersions(userId: string, plan: PracticePlan) {
  return prisma.practicePlan.findMany({
    where: { userId, versionChainId: plan.versionChainId },
    orderBy: { versionNumber: "asc" },
    select: planSummarySelect,
  });
}

export function newVersionChainId(): string {
  return randomUUID();
}
