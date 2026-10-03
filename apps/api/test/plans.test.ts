import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { AppError, sendError } from "../src/lib/errors.js";

// 用内存替身替换 Prisma 与审计（审计会间接引入原生 argon2 模块）。
const mocks = vi.hoisted(() => {
  const db = {
    practicePlan: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      aggregate: vi.fn(),
    },
    planPhase: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      aggregate: vi.fn(),
    },
    planTask: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      aggregate: vi.fn(),
      count: vi.fn(),
    },
    planTaskEvidence: {
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    goal: { count: vi.fn() },
    mediaAsset: { findFirst: vi.fn() },
  };
  return {
    ...db,
    $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(db)),
  };
});

vi.mock("../src/lib/prisma.js", () => ({ prisma: mocks }));
vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn(async () => undefined) }));

import planRoutes from "../src/routes/plans.js";

const USER = { id: "11111111-1111-1111-1111-111111111111", email: "a@b.c", displayName: "测试" };

const basePlan = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  userId: USER.id,
  goalId: null,
  title: "音准专项",
  status: "ACTIVE",
  isTemplate: false,
  versionChainId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  versionNumber: 1,
  previousVersionId: null,
  chainHead: true,
  lockedAt: null,
  totalTasks: 1,
  revision: 0,
};

async function buildTestApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest("authUser", null);
  app.decorate("authenticate", async (request: typeof app.request) => {
    request.authUser = USER;
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) return sendError(reply, error, request.id);
    return sendError(reply, new AppError(500, "INTERNAL_ERROR", "服务暂时不可用"), request.id);
  });
  await app.register(planRoutes, { prefix: "/api/v1/plans" });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.goal.count.mockResolvedValue(0);
  mocks.practicePlan.findMany.mockResolvedValue([]);
});

describe("plan routes", () => {
  it("rejects invalid create payloads before touching the database", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/plans",
      payload: { title: " ", phases: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(mocks.practicePlan.create).not.toHaveBeenCalled();
  });

  it("lists plans with cursor envelope", async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/plans?headOnly=true" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [], nextCursor: null });
    expect(mocks.practicePlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: USER.id, chainHead: true }) }),
    );
  });

  it("returns 404 for unknown plans", async () => {
    mocks.practicePlan.findFirst.mockResolvedValue(null);
    const app = await buildTestApp();
    const response = await app.inject({ method: "GET", url: `/api/v1/plans/${basePlan.id}` });
    expect(response.statusCode).toBe(404);
  });

  it("blocks structural edits on locked plans", async () => {
    mocks.practicePlan.findFirst.mockResolvedValue({ ...basePlan, lockedAt: new Date() });
    const app = await buildTestApp();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/plans/${basePlan.id}`,
      payload: { title: "改名", revision: 0 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PLAN_LOCKED");
    expect(mocks.practicePlan.updateMany).not.toHaveBeenCalled();
  });

  it("requires the plan to be locked before revising", async () => {
    mocks.practicePlan.findFirst.mockResolvedValue({ ...basePlan, lockedAt: null });
    const app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/plans/${basePlan.id}/revise`,
      payload: { changeNote: "调整阶段" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("INVALID_PLAN_STATE");
  });

  it("revises a locked plan into a new head version carrying execution", async () => {
    const lockedPlan = { ...basePlan, lockedAt: new Date(), versionNumber: 1 };
    mocks.practicePlan.findFirst.mockResolvedValue(lockedPlan);
    mocks.practicePlan.aggregate.mockResolvedValue({ _max: { versionNumber: 1 } });
    mocks.practicePlan.create.mockResolvedValue({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc" });
    mocks.practicePlan.updateMany.mockResolvedValue({ count: 1 });
    mocks.practicePlan.update.mockResolvedValue(lockedPlan);
    mocks.planPhase.findMany.mockResolvedValue([]);
    mocks.planTask.findMany.mockResolvedValue([]);
    const app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/plans/${basePlan.id}/revise`,
      payload: { changeNote: "增加第三阶段" },
    });
    expect(response.statusCode).toBe(201);
    expect(mocks.practicePlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          versionNumber: 2,
          previousVersionId: basePlan.id,
          versionChainId: basePlan.versionChainId,
          changeNote: "增加第三阶段",
        }),
      }),
    );
    expect(mocks.practicePlan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { chainHead: false } }),
    );
  });

  it("copies a plan as a fresh execution preserving lineage", async () => {
    const template = { ...basePlan, isTemplate: true, rootAncestorId: null };
    mocks.practicePlan.findFirst.mockResolvedValue(template);
    mocks.practicePlan.create.mockResolvedValue({ id: "dddddddd-dddd-dddd-dddd-dddddddddddd" });
    mocks.practicePlan.update.mockResolvedValue(template);
    mocks.planPhase.findMany.mockResolvedValue([]);
    mocks.planTask.findMany.mockResolvedValue([]);
    const app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/plans/${basePlan.id}/copy`,
      payload: { title: "我的四周计划", asTemplate: false },
    });
    expect(response.statusCode).toBe(201);
    expect(mocks.practicePlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "我的四周计划",
          copiedFromId: basePlan.id,
          rootAncestorId: basePlan.id,
          status: "DRAFT",
        }),
      }),
    );
  });

  it("blocks task execution on templates", async () => {
    mocks.practicePlan.findFirst.mockResolvedValue({ ...basePlan, isTemplate: true });
    const app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/plans/${basePlan.id}/tasks/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee/status`,
      payload: { status: "DONE" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PLAN_TEMPLATE_NOT_EXECUTABLE");
  });

  it("blocks task execution on superseded versions", async () => {
    mocks.practicePlan.findFirst.mockResolvedValue({ ...basePlan, chainHead: false });
    const app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/plans/${basePlan.id}/tasks/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee/status`,
      payload: { status: "DONE" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PLAN_VERSION_SUPERSEDED");
  });

  it("requires audio evidence before completing a task that demands it", async () => {
    mocks.practicePlan.findFirst.mockResolvedValue(basePlan);
    mocks.planTask.findFirst.mockResolvedValue({
      id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      planId: basePlan.id,
      userId: USER.id,
      evidenceRequirement: "AUDIO",
      selfReviewNote: null,
    });
    mocks.planTaskEvidence.count.mockResolvedValue(0);
    const app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/plans/${basePlan.id}/tasks/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee/status`,
      payload: { status: "DONE" },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe("TASK_REQUIREMENTS_MISSING");
    expect(body.error.details).toHaveLength(1);
    expect(mocks.planTask.update).not.toHaveBeenCalled();
  });

  it("completes a task and recomputes progress when requirements are met", async () => {
    mocks.practicePlan.findFirst.mockResolvedValue(basePlan);
    mocks.planTask.findFirst.mockResolvedValue({
      id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      planId: basePlan.id,
      userId: USER.id,
      evidenceRequirement: "NONE",
      selfReviewNote: null,
    });
    mocks.planTask.update.mockResolvedValue({});
    mocks.planTask.findMany.mockResolvedValue([{ phaseId: "p1", status: "DONE" }]);
    mocks.planPhase.findMany.mockResolvedValue([{ id: "p1" }]);
    mocks.planPhase.update.mockResolvedValue({});
    mocks.practicePlan.update.mockResolvedValue(basePlan);
    const app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/plans/${basePlan.id}/tasks/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee/status`,
      payload: { status: "DONE" },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.planTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "DONE", completedAt: expect.any(Date) }) }),
    );
    // 复算落库：阶段与计划都写入聚合结果
    expect(mocks.planPhase.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { totalTasks: 1, doneTasks: 1, skippedTasks: 0, progressPct: 100 } }),
    );
    expect(mocks.practicePlan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ totalTasks: 1, doneTasks: 1, progressPct: 100, recomputedAt: expect.any(Date) }),
      }),
    );
  });

  it("rejects evidence that is not READY or not owned", async () => {
    mocks.practicePlan.findFirst.mockResolvedValue(basePlan);
    mocks.planTask.findFirst.mockResolvedValue({ id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" });
    mocks.mediaAsset.findFirst.mockResolvedValue(null);
    const app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/plans/${basePlan.id}/tasks/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee/evidence`,
      payload: { mediaId: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.planTaskEvidence.create).not.toHaveBeenCalled();
  });
});
