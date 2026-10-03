import { describe, expect, it, vi } from "vitest";

// durationToMs 是纯函数；argon2 原生模块在部分平台无法加载，这里替换为空实现。
vi.mock("argon2", () => ({
  default: {
    hash: vi.fn(async () => "hashed"),
    verify: vi.fn(async () => true),
    needsRehash: vi.fn(() => false),
    argon2id: 2,
  },
}));

import { durationToMs } from "../src/lib/security.js";

describe("durationToMs", () => {
  it("parses supported TTL units", () => {
    expect(durationToMs("15m")).toBe(900_000);
    expect(durationToMs("30d")).toBe(2_592_000_000);
  });

  it("rejects unsupported values", () => {
    expect(() => durationToMs("15 minutes")).toThrow("Unsupported duration");
  });
});
