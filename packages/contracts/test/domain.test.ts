import { describe, expect, it } from "vitest";
import {
  calculateSessionDuration,
  canTransitionSession,
  computeProgressCounts,
  describeMissingReview,
  describeTaskCompletionMissing,
  isGoalProgressValid,
  planCreateSchema,
  planTaskStatusSchema,
  validateAnnotationRange,
} from "../src/index.js";

describe("session state machine", () => {
  it("allows the required completion transition", () => {
    expect(canTransitionSession("IN_REVIEW", "COMPLETED")).toBe(true);
    expect(canTransitionSession("DRAFT", "COMPLETED")).toBe(false);
  });
});

describe("annotation range", () => {
  it("rejects ranges under 100ms and outside media", () => {
    expect(validateAnnotationRange(100, 150, 1000)).toMatchObject({ ok: false });
    expect(validateAnnotationRange(900, 1100, 1000)).toMatchObject({ ok: false });
    expect(validateAnnotationRange(100, 250, 1000)).toEqual({ ok: true });
  });
});

describe("review completion", () => {
  it("returns every missing item instead of a generic failure", () => {
    expect(
      describeMissingReview({
        readyMediaCount: 0,
        annotationCount: 0,
        noIssues: false,
        nextFocus: "",
        openGoalCount: 0,
        newGoalCount: 0,
        progressUpdateCount: 0,
      }),
    ).toHaveLength(4);
  });
});

describe("goal values", () => {
  it("suggests achieved only when actual reaches target", () => {
    expect(isGoalProgressValid(90, 88)).toBe(true);
    expect(isGoalProgressValid(87, 88)).toBe(false);
  });

  it("sums only valid media durations", () => {
    expect(calculateSessionDuration([1000, null, 2500, -1])).toBe(3500);
  });
});

describe("plan progress recomputation", () => {
  it("computes percent from done over effective scope", () => {
    expect(computeProgressCounts(["DONE", "DONE", "PENDING", "IN_PROGRESS"])).toEqual({
      total: 4,
      done: 2,
      skipped: 0,
      percent: 50,
    });
  });

  it("excludes skipped tasks from the denominator", () => {
    expect(computeProgressCounts(["DONE", "SKIPPED", "SKIPPED", "DONE"])).toEqual({
      total: 4,
      done: 2,
      skipped: 2,
      percent: 100,
    });
  });

  it("returns zero when nothing is in scope", () => {
    expect(computeProgressCounts([])).toEqual({ total: 0, done: 0, skipped: 0, percent: 0 });
    expect(computeProgressCounts(["SKIPPED"]).percent).toBe(0);
  });

  it("rounds to whole percents", () => {
    expect(computeProgressCounts(["DONE", "PENDING", "PENDING"]).percent).toBe(33);
  });
});

describe("task completion evidence gate", () => {
  it("requires audio evidence when the task demands it", () => {
    expect(
      describeTaskCompletionMissing({ evidenceRequirement: "AUDIO", evidenceCount: 0 }),
    ).toHaveLength(1);
    expect(
      describeTaskCompletionMissing({ evidenceRequirement: "AUDIO", evidenceCount: 1 }),
    ).toHaveLength(0);
  });

  it("requires both audio and self review for the combined requirement", () => {
    expect(
      describeTaskCompletionMissing({ evidenceRequirement: "AUDIO_AND_SELF_REVIEW", evidenceCount: 1, selfReviewNote: " " }),
    ).toHaveLength(1);
    expect(
      describeTaskCompletionMissing({
        evidenceRequirement: "AUDIO_AND_SELF_REVIEW",
        evidenceCount: 1,
        selfReviewNote: "三遍慢练后节奏稳定",
      }),
    ).toHaveLength(0);
  });

  it("lets tasks without requirements complete freely", () => {
    expect(describeTaskCompletionMissing({ evidenceRequirement: "NONE", evidenceCount: 0 })).toHaveLength(0);
  });
});

describe("plan schemas", () => {
  it("accepts a nested plan with phases and tasks", () => {
    const parsed = planCreateSchema.parse({
      title: "音准专项四周计划",
      phases: [
        { title: "第一阶段", tasks: [{ title: "空弦长音", evidenceRequirement: "AUDIO" }] },
      ],
    });
    expect(parsed.phases).toHaveLength(1);
    expect(parsed.phases[0]?.tasks[0]?.evidenceRequirement).toBe("AUDIO");
    expect(parsed.isTemplate).toBe(false);
  });

  it("rejects empty titles and unknown task statuses", () => {
    expect(planCreateSchema.safeParse({ title: " " }).success).toBe(false);
    expect(planTaskStatusSchema.safeParse({ status: "BLOCKED" }).success).toBe(false);
  });
});
