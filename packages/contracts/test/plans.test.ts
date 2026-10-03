import { describe, expect, it } from "vitest";
import {
  canAttachPlanEvidence,
  canEditPlanStructure,
  canLockPlan,
  canRevisePlan,
  computePlanProgress,
  describePlanLockBlockers,
  planStructureSchema,
  type PlanStageSnapshot,
} from "../src/index.js";

const task = (id: string, requiredEvidence = 1, weight = 1) => ({
  id,
  title: `任务${id}`,
  requiredEvidence,
  weight,
});

const stage = (id: string, order: number, tasks: ReturnType<typeof task>[]): PlanStageSnapshot => ({
  id,
  title: `阶段${id}`,
  order,
  tasks,
});

describe("computePlanProgress", () => {
  it("空计划进度为 0 且未完成", () => {
    const report = computePlanProgress([], new Map());
    expect(report).toMatchObject({ totalTasks: 0, doneTasks: 0, ratio: 0, percent: 0, complete: false });
  });

  it("证据数达到 requiredEvidence 才算完成任务", () => {
    const stages = [stage("s1", 1, [task("t1", 2), task("t2")])];
    const report = computePlanProgress(
      stages,
      new Map([
        ["t1", 1], // 1/2 未完成
        ["t2", 3], // 3/1 完成（超出也计为完成）
      ]),
    );
    expect(report.doneTasks).toBe(1);
    expect(report.totalTasks).toBe(2);
    expect(report.ratio).toBeCloseTo(0.5);
    expect(report.stages[0]?.tasks[0]).toMatchObject({ taskId: "t1", evidenceCount: 1, done: false });
    expect(report.stages[0]?.tasks[1]).toMatchObject({ taskId: "t2", evidenceCount: 3, done: true });
  });

  it("阶段与整体都按任务权重加权汇总", () => {
    const stages = [stage("s1", 1, [task("t1", 1, 3), task("t2", 1, 1)])];
    const report = computePlanProgress(stages, new Map([["t2", 1]]));
    expect(report.ratio).toBeCloseTo(0.25);
    expect(report.stages[0]?.ratio).toBeCloseTo(0.25);
    expect(report.doneWeight).toBeCloseTo(1);
    expect(report.totalWeight).toBeCloseTo(4);
  });

  it("多个阶段按 order 排序后汇总", () => {
    const stages = [stage("s2", 2, [task("t2")]), stage("s1", 1, [task("t1")])];
    const report = computePlanProgress(stages, new Map());
    expect(report.stages.map((s) => s.stageId)).toEqual(["s1", "s2"]);
  });

  it("全部任务完成时 complete 为 true 且 percent 为 100", () => {
    const stages = [stage("s1", 1, [task("t1", 2), task("t2")])];
    const report = computePlanProgress(
      stages,
      new Map([
        ["t1", 2],
        ["t2", 1],
      ]),
    );
    expect(report.complete).toBe(true);
    expect(report.percent).toBe(100);
  });

  it("可复算：相同输入重复计算得到完全一致的结果", () => {
    const stages = [stage("s1", 1, [task("t1", 2), task("t2", 1, 2.5)])];
    const counts = new Map([["t1", 2]]);
    const first = computePlanProgress(stages, counts);
    const second = computePlanProgress(stages, counts);
    expect(first).toEqual(second);
    // 证据变化后重算结果随之变化（删除证据进度回退）
    const afterRemoval = computePlanProgress(stages, new Map());
    expect(afterRemoval.ratio).toBeLessThan(first.ratio);
  });
});

describe("describePlanLockBlockers", () => {
  it("没有阶段时阻止锁定", () => {
    expect(describePlanLockBlockers([])).toEqual(["计划至少包含一个阶段"]);
  });

  it("空任务阶段会按阶段名列出", () => {
    const blockers = describePlanLockBlockers([
      { title: "慢练", order: 1, tasks: [] },
      { title: "合乐", order: 2, tasks: [{}] },
    ]);
    expect(blockers).toEqual(["阶段「慢练」至少需要一个任务"]);
  });

  it("结构完整时返回空数组", () => {
    expect(describePlanLockBlockers([{ title: "慢练", order: 1, tasks: [{}] }])).toEqual([]);
  });
});

describe("plan state guards", () => {
  it("仅草稿可编辑结构、可锁定", () => {
    expect(canEditPlanStructure("DRAFT")).toBe(true);
    expect(canEditPlanStructure("LOCKED")).toBe(false);
    expect(canEditPlanStructure("ARCHIVED")).toBe(false);
    expect(canLockPlan("DRAFT")).toBe(true);
    expect(canLockPlan("LOCKED")).toBe(false);
  });

  it("仅已锁定可改版、可挂载证据", () => {
    expect(canRevisePlan("LOCKED")).toBe(true);
    expect(canRevisePlan("DRAFT")).toBe(false);
    expect(canRevisePlan("ARCHIVED")).toBe(false);
    expect(canAttachPlanEvidence("LOCKED")).toBe(true);
    expect(canAttachPlanEvidence("DRAFT")).toBe(false);
    expect(canAttachPlanEvidence("ARCHIVED")).toBe(false);
  });
});

describe("planStructureSchema", () => {
  const validTask = { title: "音阶慢练" };
  const validStage = { title: "第一阶段", tasks: [validTask] };

  it("接受合法结构并填充默认值", () => {
    const parsed = planStructureSchema.parse({ revision: 0, stages: [validStage] });
    expect(parsed.stages[0]?.tasks[0]).toMatchObject({ requiredEvidence: 1, weight: 1 });
  });

  it("拒绝重复的阶段 id 与任务 id", () => {
    const id = "7b8f7c5a-9c2f-4c1a-9a5b-0f3f0d3a9a11";
    const duplicatedStages = planStructureSchema.safeParse({
      revision: 0,
      stages: [
        { ...validStage, id },
        { ...validStage, id },
      ],
    });
    expect(duplicatedStages.success).toBe(false);

    const taskId = "1c9a4f6d-2c3b-4f5e-8a7b-6c5d4e3f2a1b";
    const duplicatedTasks = planStructureSchema.safeParse({
      revision: 0,
      stages: [
        { title: "阶段一", tasks: [{ ...validTask, id: taskId }] },
        { title: "阶段二", tasks: [{ ...validTask, id: taskId }] },
      ],
    });
    expect(duplicatedTasks.success).toBe(false);
  });

  it("要求 requiredEvidence 至少为 1", () => {
    const result = planStructureSchema.safeParse({
      revision: 0,
      stages: [{ title: "阶段", tasks: [{ title: "任务", requiredEvidence: 0 }] }],
    });
    expect(result.success).toBe(false);
  });
});
