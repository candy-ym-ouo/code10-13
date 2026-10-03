import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  practicePlan: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  planTemplate: {
    findFirst: vi.fn(),
  },
  planStage: { create: vi.fn() },
  planTask: { create: vi.fn(), findFirst: vi.fn() },
  planTaskEvidence: { create: vi.fn() },
  mediaAsset: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: prismaMock }));

import { AppError } from "../src/lib/errors.js";
import { addEvidence, getPlanLineage, lockPlan, revisePlan } from "../src/services/plan-service.js";

const USER = "user-1";

const lockedPlanWithEvidence = () => ({
  id: "plan-v1",
  userId: USER,
  goal: "四周拿下克莱采尔第 2 课",
  status: "LOCKED",
  version: 1,
  stages: [
    {
      id: "stage-1",
      title: "慢练",
      order: 1,
      tasks: [
        {
          id: "task-1",
          title: "1-8 小节 60 BPM",
          detail: null,
          requiredEvidence: 2,
          weight: 2,
          order: 1,
          evidences: [
            { id: "evd-1", mediaId: "media-1", note: "第一遍" },
            { id: "evd-2", mediaId: "media-2", note: null },
          ],
        },
        { id: "task-2", title: "换把音准", detail: null, requiredEvidence: 1, weight: 1, order: 2, evidences: [] },
      ],
    },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("revisePlan", () => {
  it("归档旧版本、新建 version+1 草稿并继承证据", async () => {
    const source = lockedPlanWithEvidence();
    prismaMock.practicePlan.findFirst.mockImplementation(({ where, include }) => {
      if (where.id === "plan-v1" && include?.stages) return Promise.resolve(source);
      if (where.id === "plan-v2") return Promise.resolve({ id: "plan-v2", version: 2 });
      return Promise.resolve(null);
    });
    const tx = {
      practicePlan: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue({ id: "plan-v2" }),
      },
      planStage: { create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: `new-${data.derivedFromStageId}` })) },
      planTask: { create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: `new-${data.derivedFromTaskId}` })) },
      planTaskEvidence: { create: vi.fn().mockResolvedValue({}) },
    };
    prismaMock.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(tx));

    const result = await revisePlan(USER, "plan-v1");

    expect(result).toEqual({ id: "plan-v2", version: 2 });
    // 旧版本在同一事务内归档
    expect(tx.practicePlan.updateMany).toHaveBeenCalledWith({
      where: { id: "plan-v1", userId: USER, status: "LOCKED" },
      data: expect.objectContaining({ status: "ARCHIVED" }),
    });
    // 新版本：version+1、草稿、谱系指向旧版本
    expect(tx.practicePlan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "DRAFT",
        version: 2,
        originType: "REVISION",
        originPlanId: "plan-v1",
        originPlanVersion: 1,
      }),
    });
    // 结构深拷贝并记录任务级谱系
    expect(tx.planStage.create).toHaveBeenCalledWith({ data: expect.objectContaining({ derivedFromStageId: "stage-1" }) });
    expect(tx.planTask.create).toHaveBeenCalledTimes(2);
    expect(tx.planTask.create).toHaveBeenCalledWith({ data: expect.objectContaining({ derivedFromTaskId: "task-1" }) });
    // 证据克隆到新任务，inheritedFromId 指回旧证据
    expect(tx.planTaskEvidence.create).toHaveBeenCalledTimes(2);
    expect(tx.planTaskEvidence.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ planId: "plan-v2", taskId: "new-task-1", mediaId: "media-1", inheritedFromId: "evd-1" }),
    });
    expect(tx.planTaskEvidence.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ inheritedFromId: "evd-2", taskId: "new-task-1" }),
    });
  });

  it("草稿计划不能改版", async () => {
    prismaMock.practicePlan.findFirst.mockResolvedValue({ ...lockedPlanWithEvidence(), status: "DRAFT" });
    await expect(revisePlan(USER, "plan-v1")).rejects.toMatchObject({ statusCode: 409, code: "INVALID_PLAN_STATE" });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

describe("lockPlan", () => {
  it("结构不完整时返回全部阻止项", async () => {
    prismaMock.practicePlan.findFirst.mockResolvedValue({
      id: "plan-1",
      status: "DRAFT",
      stages: [{ id: "s1", title: "慢练", order: 1, tasks: [] }],
    });
    const error = (await lockPlan(USER, "plan-1").catch((e: unknown) => e)) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("PLAN_LOCK_BLOCKED");
    expect(error.details).toEqual(["阶段「慢练」至少需要一个任务"]);
    expect(prismaMock.practicePlan.updateMany).not.toHaveBeenCalled();
  });

  it("已锁定计划不能重复锁定", async () => {
    prismaMock.practicePlan.findFirst.mockResolvedValue({ id: "plan-1", status: "LOCKED", stages: [] });
    await expect(lockPlan(USER, "plan-1")).rejects.toMatchObject({ statusCode: 409, code: "INVALID_PLAN_STATE" });
  });
});

describe("addEvidence", () => {
  it("仅锁定中的计划可以挂载证据", async () => {
    prismaMock.practicePlan.findFirst.mockResolvedValue({ id: "plan-1", status: "DRAFT" });
    await expect(addEvidence(USER, "plan-1", "task-1", { mediaId: "m1", note: null })).rejects.toMatchObject({
      statusCode: 409,
      code: "INVALID_PLAN_STATE",
    });
  });

  it("证据音频必须是本人已就绪的媒体", async () => {
    prismaMock.practicePlan.findFirst.mockResolvedValue({ id: "plan-1", status: "LOCKED" });
    prismaMock.planTask.findFirst.mockResolvedValue({ id: "task-1" });
    prismaMock.mediaAsset.findFirst.mockResolvedValue(null);
    await expect(addEvidence(USER, "plan-1", "task-1", { mediaId: "m1", note: null })).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
  });
});

describe("getPlanLineage", () => {
  it("沿改版与模板一路回溯到源头", async () => {
    const plans: Record<string, object> = {
      "plan-v3": { id: "plan-v3", goal: "克莱采尔第 2 课", version: 3, status: "DRAFT", originType: "REVISION", originPlanId: "plan-v2", originPlanVersion: 2, originTemplateId: null },
      "plan-v2": { id: "plan-v2", goal: "克莱采尔第 2 课", version: 2, status: "ARCHIVED", originType: "REVISION", originPlanId: "plan-v1", originPlanVersion: 1, originTemplateId: null },
      "plan-v1": { id: "plan-v1", goal: "克莱采尔第 2 课", version: 1, status: "ARCHIVED", originType: "TEMPLATE", originPlanId: null, originPlanVersion: null, originTemplateId: "tpl-1" },
      "plan-seed": { id: "plan-seed", goal: "原始计划", version: 1, status: "ARCHIVED", originType: "SCRATCH", originPlanId: null, originPlanVersion: null, originTemplateId: null },
    };
    prismaMock.practicePlan.findFirst.mockImplementation(({ where }) => Promise.resolve(plans[where.id as string] ?? null));
    prismaMock.planTemplate.findFirst.mockResolvedValue({ id: "tpl-1", name: "克莱采尔模板", sourcePlanId: "plan-seed" });

    const lineage = await getPlanLineage(USER, "plan-v3");

    expect(lineage.map((node) => [node.kind, node.id])).toEqual([
      ["PLAN", "plan-v3"],
      ["PLAN", "plan-v2"],
      ["PLAN", "plan-v1"],
      ["TEMPLATE", "tpl-1"],
      ["PLAN", "plan-seed"],
    ]);
    expect(lineage[0]).toMatchObject({ planVersion: 3, originType: "REVISION", missing: false });
    expect(lineage[3]).toMatchObject({ label: "克莱采尔模板", planVersion: null });
    expect(lineage[4]).toMatchObject({ originType: "SCRATCH" });
  });

  it("来源实体缺失时以 missing 节点收尾", async () => {
    prismaMock.practicePlan.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.id === "plan-copy"
          ? { id: "plan-copy", goal: "副本", version: 1, status: "DRAFT", originType: "PLAN_COPY", originPlanId: "gone", originPlanVersion: 2, originTemplateId: null }
          : null,
      ),
    );
    const lineage = await getPlanLineage(USER, "plan-copy");
    expect(lineage).toHaveLength(2);
    expect(lineage[1]).toMatchObject({ kind: "PLAN", id: "gone", missing: true, planVersion: 2 });
  });
});
