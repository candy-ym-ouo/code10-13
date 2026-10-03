import type { FastifyPluginAsync } from "fastify";
import {
  describeTaskCompletionMissing,
  planCopySchema,
  planCreateSchema,
  planEvidenceCreateSchema,
  planListQuerySchema,
  planPhaseCreateSchema,
  planPhaseUpdateSchema,
  planReviseSchema,
  planTaskCreateSchema,
  planTaskStatusSchema,
  planTaskUpdateSchema,
  planUpdateSchema,
} from "@practice/contracts";
import { AppError, notFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { parseOrThrow } from "../lib/validation.js";
import { audit } from "../lib/audit.js";
import {
  assertPlanExecutable,
  assertPlanStructureMutable,
  copyPlanStructure,
  getPlanDetail,
  getPlanForUser,
  getPlanLineage,
  getPlanVersions,
  newVersionChainId,
  recomputePlanProgress,
} from "../services/plan-service.js";

async function nextPhaseOrderIndex(planId: string): Promise<number> {
  const max = await prisma.planPhase.aggregate({ where: { planId }, _max: { orderIndex: true } });
  return (max._max.orderIndex ?? -1) + 1;
}

async function nextTaskOrderIndex(phaseId: string): Promise<number> {
  const max = await prisma.planTask.aggregate({ where: { phaseId }, _max: { orderIndex: true } });
  return (max._max.orderIndex ?? -1) + 1;
}

async function assertGoalsOwned(userId: string, goalIds: Array<string | null | undefined>): Promise<void> {
  const ids = [...new Set(goalIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return;
  const owned = await prisma.goal.count({ where: { userId, id: { in: ids } } });
  if (owned !== ids.length) throw new AppError(400, "VALIDATION_ERROR", "关联目标不存在或不属于当前用户");
}

const planRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request) => {
    const query = parseOrThrow(planListQuerySchema, request.query);
    const data = await prisma.practicePlan.findMany({
      where: {
        userId: request.authUser!.id,
        ...(query.status ? { status: query.status } : {}),
        ...(query.isTemplate === undefined ? {} : { isTemplate: query.isTemplate }),
        ...(query.headOnly ? { chainHead: true } : {}),
      },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      include: { goal: { select: { id: true, title: true, status: true } } },
    });
    const hasMore = data.length > query.limit;
    const items = hasMore ? data.slice(0, query.limit) : data;
    return { data: items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  });

  app.post("/", async (request, reply) => {
    const input = parseOrThrow(planCreateSchema, request.body);
    const userId = request.authUser!.id;
    await assertGoalsOwned(userId, [
      input.goalId,
      ...input.phases.flatMap((phase) => phase.tasks.map((task) => task.linkedGoalId)),
    ]);
    const planId = await prisma.$transaction(async (tx) => {
      const plan = await tx.practicePlan.create({
        data: {
          userId,
          goalId: input.goalId ?? null,
          title: input.title,
          description: input.description ?? null,
          instrument: input.instrument ?? null,
          isTemplate: input.isTemplate,
          startDate: input.startDate ?? null,
          dueDate: input.dueDate ?? null,
          versionChainId: newVersionChainId(),
        },
      });
      for (const [phaseIndex, phase] of input.phases.entries()) {
        const createdPhase = await tx.planPhase.create({
          data: { planId: plan.id, userId, title: phase.title, description: phase.description ?? null, orderIndex: phaseIndex },
        });
        for (const [taskIndex, task] of phase.tasks.entries()) {
          await tx.planTask.create({
            data: {
              planId: plan.id,
              phaseId: createdPhase.id,
              userId,
              title: task.title,
              description: task.description ?? null,
              orderIndex: taskIndex,
              evidenceRequirement: task.evidenceRequirement,
              estimateMinutes: task.estimateMinutes ?? null,
              dueDate: task.dueDate ?? null,
              linkedGoalId: task.linkedGoalId ?? null,
            },
          });
        }
      }
      await recomputePlanProgress(tx, plan.id);
      return plan.id;
    });
    await audit(request, "PLAN_CREATED", "PRACTICE_PLAN", planId, "SUCCESS");
    return reply.status(201).send({ plan: await getPlanDetail(userId, planId) });
  });

  app.get("/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { plan: await getPlanDetail(request.authUser!.id, id) };
  });

  app.patch("/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(planUpdateSchema, request.body);
    const existing = await getPlanForUser(request.authUser!.id, id);
    assertPlanStructureMutable(existing);
    if (input.goalId) await assertGoalsOwned(request.authUser!.id, [input.goalId]);
    const updated = await prisma.practicePlan.updateMany({
      where: { id, userId: request.authUser!.id, revision: input.revision },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.instrument === undefined ? {} : { instrument: input.instrument }),
        ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
        ...(input.isTemplate === undefined ? {} : { isTemplate: input.isTemplate }),
        ...(input.startDate === undefined ? {} : { startDate: input.startDate }),
        ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
        revision: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "计划已在其他窗口被修改");
    return { plan: await getPlanDetail(request.authUser!.id, id) };
  });

  app.post("/:id/lock", async (request) => {
    const { id } = request.params as { id: string };
    const existing = await getPlanForUser(request.authUser!.id, id);
    if (!existing.lockedAt) {
      await prisma.practicePlan.update({ where: { id }, data: { lockedAt: new Date(), revision: { increment: 1 } } });
      await audit(request, "PLAN_LOCKED", "PRACTICE_PLAN", id, "SUCCESS");
    }
    return { plan: await getPlanDetail(request.authUser!.id, id) };
  });

  app.post("/:id/unlock", async (request) => {
    const { id } = request.params as { id: string };
    const existing = await getPlanForUser(request.authUser!.id, id);
    if (existing.lockedAt) {
      if (!existing.chainHead) {
        throw new AppError(409, "PLAN_VERSION_SUPERSEDED", "已存在新版本，旧版本保持锁定封存");
      }
      await prisma.practicePlan.update({ where: { id }, data: { lockedAt: null, revision: { increment: 1 } } });
      await audit(request, "PLAN_UNLOCKED", "PRACTICE_PLAN", id, "SUCCESS");
    }
    return { plan: await getPlanDetail(request.authUser!.id, id) };
  });

  app.post("/:id/revise", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(planReviseSchema, request.body);
    const userId = request.authUser!.id;
    const source = await getPlanForUser(userId, id);
    if (!source.lockedAt) {
      throw new AppError(409, "INVALID_PLAN_STATE", "只有已锁定的计划才能改版");
    }
    const newPlanId = await prisma.$transaction(async (tx) => {
      const maxVersion = await tx.practicePlan.aggregate({
        where: { versionChainId: source.versionChainId },
        _max: { versionNumber: true },
      });
      const plan = await tx.practicePlan.create({
        data: {
          userId,
          goalId: source.goalId,
          title: source.title,
          description: source.description,
          instrument: source.instrument,
          status: source.status === "ACTIVE" ? "ACTIVE" : "DRAFT",
          isTemplate: source.isTemplate,
          versionChainId: source.versionChainId,
          versionNumber: (maxVersion._max.versionNumber ?? source.versionNumber) + 1,
          previousVersionId: source.id,
          changeNote: input.changeNote ?? null,
          copiedFromId: source.copiedFromId,
          rootAncestorId: source.rootAncestorId,
          startDate: source.startDate,
          dueDate: source.dueDate,
        },
      });
      await tx.practicePlan.updateMany({
        where: { versionChainId: source.versionChainId, id: { not: plan.id } },
        data: { chainHead: false },
      });
      await copyPlanStructure(tx, { sourcePlanId: source.id, targetPlanId: plan.id, userId, carryExecution: true });
      await recomputePlanProgress(tx, plan.id);
      return plan.id;
    });
    await audit(request, "PLAN_REVISED", "PRACTICE_PLAN", newPlanId, "SUCCESS", { sourcePlanId: id });
    return reply.status(201).send({ plan: await getPlanDetail(userId, newPlanId) });
  });

  app.post("/:id/copy", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(planCopySchema, request.body);
    const userId = request.authUser!.id;
    const source = await getPlanForUser(userId, id);
    const newPlanId = await prisma.$transaction(async (tx) => {
      const plan = await tx.practicePlan.create({
        data: {
          userId,
          goalId: source.goalId,
          title: (input.title ?? `${source.title}（副本）`).slice(0, 160),
          description: source.description,
          instrument: source.instrument,
          status: "DRAFT",
          isTemplate: input.asTemplate,
          versionChainId: newVersionChainId(),
          copiedFromId: source.id,
          rootAncestorId: source.rootAncestorId ?? source.id,
          startDate: source.startDate,
          dueDate: source.dueDate,
        },
      });
      await copyPlanStructure(tx, { sourcePlanId: source.id, targetPlanId: plan.id, userId, carryExecution: false });
      await recomputePlanProgress(tx, plan.id);
      return plan.id;
    });
    await audit(request, "PLAN_COPIED", "PRACTICE_PLAN", newPlanId, "SUCCESS", { sourcePlanId: id });
    return reply.status(201).send({ plan: await getPlanDetail(userId, newPlanId) });
  });

  app.get("/:id/lineage", async (request) => {
    const { id } = request.params as { id: string };
    const plan = await getPlanForUser(request.authUser!.id, id);
    return getPlanLineage(request.authUser!.id, plan);
  });

  app.get("/:id/versions", async (request) => {
    const { id } = request.params as { id: string };
    const plan = await getPlanForUser(request.authUser!.id, id);
    return { data: await getPlanVersions(request.authUser!.id, plan) };
  });

  app.post("/:id/activate", async (request) => {
    const { id } = request.params as { id: string };
    const plan = await getPlanForUser(request.authUser!.id, id);
    if (plan.isTemplate) throw new AppError(409, "PLAN_TEMPLATE_NOT_EXECUTABLE", "模板无需启用，请复制为练习计划");
    if (!plan.chainHead) throw new AppError(409, "PLAN_VERSION_SUPERSEDED", "请切换到最新版本再启用");
    if (plan.status !== "DRAFT") throw new AppError(409, "INVALID_PLAN_STATE", "只有草稿状态的计划可以启用");
    if (plan.totalTasks < 1) throw new AppError(409, "INVALID_PLAN_STATE", "请先为计划添加至少一个任务");
    await prisma.practicePlan.update({
      where: { id },
      data: { status: "ACTIVE", revision: { increment: 1 } },
    });
    await audit(request, "PLAN_ACTIVATED", "PRACTICE_PLAN", id, "SUCCESS");
    return { plan: await getPlanDetail(request.authUser!.id, id) };
  });

  app.post("/:id/complete", async (request) => {
    const { id } = request.params as { id: string };
    const plan = await getPlanForUser(request.authUser!.id, id);
    if (plan.status !== "ACTIVE") throw new AppError(409, "INVALID_PLAN_STATE", "只有进行中的计划可以完成");
    await prisma.practicePlan.update({
      where: { id },
      data: { status: "COMPLETED", revision: { increment: 1 } },
    });
    await audit(request, "PLAN_COMPLETED", "PRACTICE_PLAN", id, "SUCCESS");
    return { plan: await getPlanDetail(request.authUser!.id, id) };
  });

  app.post("/:id/archive", async (request) => {
    const { id } = request.params as { id: string };
    const plan = await getPlanForUser(request.authUser!.id, id);
    if (plan.status === "ARCHIVED") return { plan: await getPlanDetail(request.authUser!.id, id) };
    await prisma.practicePlan.update({
      where: { id },
      data: { status: "ARCHIVED", revision: { increment: 1 } },
    });
    await audit(request, "PLAN_ARCHIVED", "PRACTICE_PLAN", id, "SUCCESS");
    return { plan: await getPlanDetail(request.authUser!.id, id) };
  });

  app.post("/:id/recompute", async (request) => {
    const { id } = request.params as { id: string };
    await getPlanForUser(request.authUser!.id, id);
    await recomputePlanProgress(prisma, id);
    return { plan: await getPlanDetail(request.authUser!.id, id) };
  });

  app.post("/:id/phases", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(planPhaseCreateSchema, request.body);
    const userId = request.authUser!.id;
    const plan = await getPlanForUser(userId, id);
    assertPlanStructureMutable(plan);
    const phase = await prisma.planPhase.create({
      data: {
        planId: id,
        userId,
        title: input.title,
        description: input.description ?? null,
        orderIndex: await nextPhaseOrderIndex(id),
      },
    });
    return reply.status(201).send({ phase });
  });

  app.patch("/:id/phases/:phaseId", async (request) => {
    const { id, phaseId } = request.params as { id: string; phaseId: string };
    const input = parseOrThrow(planPhaseUpdateSchema, request.body);
    const plan = await getPlanForUser(request.authUser!.id, id);
    assertPlanStructureMutable(plan);
    const updated = await prisma.planPhase.updateMany({
      where: { id: phaseId, planId: id, userId: request.authUser!.id },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.orderIndex === undefined ? {} : { orderIndex: input.orderIndex }),
      },
    });
    if (updated.count !== 1) throw notFound();
    return { phase: await prisma.planPhase.findUniqueOrThrow({ where: { id: phaseId } }) };
  });

  app.delete("/:id/phases/:phaseId", async (request) => {
    const { id, phaseId } = request.params as { id: string; phaseId: string };
    const plan = await getPlanForUser(request.authUser!.id, id);
    assertPlanStructureMutable(plan);
    await prisma.$transaction(async (tx) => {
      const deleted = await tx.planPhase.deleteMany({ where: { id: phaseId, planId: id, userId: request.authUser!.id } });
      if (deleted.count !== 1) throw notFound();
      await recomputePlanProgress(tx, id);
    });
    return { success: true };
  });

  app.post("/:id/phases/:phaseId/tasks", async (request, reply) => {
    const { id, phaseId } = request.params as { id: string; phaseId: string };
    const input = parseOrThrow(planTaskCreateSchema, request.body);
    const userId = request.authUser!.id;
    const plan = await getPlanForUser(userId, id);
    assertPlanStructureMutable(plan);
    const phase = await prisma.planPhase.findFirst({ where: { id: phaseId, planId: id, userId } });
    if (!phase) throw notFound();
    await assertGoalsOwned(userId, [input.linkedGoalId]);
    const task = await prisma.$transaction(async (tx) => {
      const created = await tx.planTask.create({
        data: {
          planId: id,
          phaseId,
          userId,
          title: input.title,
          description: input.description ?? null,
          orderIndex: await nextTaskOrderIndex(phaseId),
          evidenceRequirement: input.evidenceRequirement,
          estimateMinutes: input.estimateMinutes ?? null,
          dueDate: input.dueDate ?? null,
          linkedGoalId: input.linkedGoalId ?? null,
        },
      });
      await recomputePlanProgress(tx, id);
      return created;
    });
    return reply.status(201).send({ task });
  });

  app.patch("/:id/tasks/:taskId", async (request) => {
    const { id, taskId } = request.params as { id: string; taskId: string };
    const input = parseOrThrow(planTaskUpdateSchema, request.body);
    const userId = request.authUser!.id;
    const plan = await getPlanForUser(userId, id);
    assertPlanStructureMutable(plan);
    if (input.phaseId) {
      const phase = await prisma.planPhase.findFirst({ where: { id: input.phaseId, planId: id, userId } });
      if (!phase) throw new AppError(400, "VALIDATION_ERROR", "目标阶段不属于当前计划");
    }
    await assertGoalsOwned(userId, [input.linkedGoalId]);
    const updated = await prisma.planTask.updateMany({
      where: { id: taskId, planId: id, userId },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.orderIndex === undefined ? {} : { orderIndex: input.orderIndex }),
        ...(input.phaseId === undefined ? {} : { phaseId: input.phaseId }),
        ...(input.evidenceRequirement === undefined ? {} : { evidenceRequirement: input.evidenceRequirement }),
        ...(input.estimateMinutes === undefined ? {} : { estimateMinutes: input.estimateMinutes }),
        ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
        ...(input.linkedGoalId === undefined ? {} : { linkedGoalId: input.linkedGoalId }),
      },
    });
    if (updated.count !== 1) throw notFound();
    await recomputePlanProgress(prisma, id);
    return { task: await prisma.planTask.findUniqueOrThrow({ where: { id: taskId } }) };
  });

  app.delete("/:id/tasks/:taskId", async (request) => {
    const { id, taskId } = request.params as { id: string; taskId: string };
    const plan = await getPlanForUser(request.authUser!.id, id);
    assertPlanStructureMutable(plan);
    await prisma.$transaction(async (tx) => {
      const deleted = await tx.planTask.deleteMany({ where: { id: taskId, planId: id, userId: request.authUser!.id } });
      if (deleted.count !== 1) throw notFound();
      await recomputePlanProgress(tx, id);
    });
    return { success: true };
  });

  app.post("/:id/tasks/:taskId/status", async (request) => {
    const { id, taskId } = request.params as { id: string; taskId: string };
    const input = parseOrThrow(planTaskStatusSchema, request.body);
    const userId = request.authUser!.id;
    const plan = await getPlanForUser(userId, id);
    assertPlanExecutable(plan);
    const task = await prisma.planTask.findFirst({ where: { id: taskId, planId: id, userId } });
    if (!task) throw notFound();
    const selfReviewNote = input.selfReviewNote === undefined ? task.selfReviewNote : input.selfReviewNote;
    if (input.status === "DONE") {
      const evidenceCount = await prisma.planTaskEvidence.count({ where: { taskId } });
      const missing = describeTaskCompletionMissing({
        evidenceRequirement: task.evidenceRequirement,
        evidenceCount,
        selfReviewNote,
      });
      if (missing.length) {
        throw new AppError(409, "TASK_REQUIREMENTS_MISSING", "任务完成条件未满足", missing);
      }
    }
    await prisma.$transaction(async (tx) => {
      await tx.planTask.update({
        where: { id: taskId },
        data: {
          status: input.status,
          selfReviewNote,
          completedAt: input.status === "DONE" ? new Date() : null,
        },
      });
      await recomputePlanProgress(tx, id);
    });
    return { plan: await getPlanDetail(userId, id) };
  });

  app.post("/:id/tasks/:taskId/evidence", async (request, reply) => {
    const { id, taskId } = request.params as { id: string; taskId: string };
    const input = parseOrThrow(planEvidenceCreateSchema, request.body);
    const userId = request.authUser!.id;
    const plan = await getPlanForUser(userId, id);
    assertPlanExecutable(plan);
    const task = await prisma.planTask.findFirst({ where: { id: taskId, planId: id, userId }, select: { id: true } });
    if (!task) throw notFound();
    const media = await prisma.mediaAsset.findFirst({
      where: { id: input.mediaId, userId, status: "READY" },
      select: { id: true },
    });
    if (!media) throw new AppError(400, "VALIDATION_ERROR", "证据音频不存在或尚未解析完成");
    const duplicate = await prisma.planTaskEvidence.findFirst({ where: { taskId, mediaId: input.mediaId } });
    if (duplicate) throw new AppError(409, "EVIDENCE_EXISTS", "该音频已关联到此任务");
    const evidence = await prisma.planTaskEvidence.create({
      data: { taskId, planId: id, userId, mediaId: input.mediaId, note: input.note ?? null },
      include: { media: { select: { id: true, sessionId: true, originalName: true, status: true, durationMs: true } } },
    });
    await audit(request, "PLAN_EVIDENCE_ATTACHED", "PLAN_TASK", taskId, "SUCCESS", { mediaId: input.mediaId });
    return reply.status(201).send({ evidence });
  });

  app.delete("/:id/tasks/:taskId/evidence/:evidenceId", async (request) => {
    const { id, taskId, evidenceId } = request.params as { id: string; taskId: string; evidenceId: string };
    const plan = await getPlanForUser(request.authUser!.id, id);
    assertPlanExecutable(plan);
    const deleted = await prisma.planTaskEvidence.deleteMany({
      where: { id: evidenceId, taskId, planId: id, userId: request.authUser!.id },
    });
    if (deleted.count !== 1) throw notFound();
    return { success: true };
  });
};

export default planRoutes;
