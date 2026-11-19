import { describe, expect, it } from "vitest";
import { isWithin, normalizeScopePath } from "../../src/core/paths.ts";

describe("scope helpers (T002/T003, FR-008)", () => {
  it("normalizeScopePath collapses equivalent spellings", () => {
    expect(normalizeScopePath("/a/b/")).toBe("/a/b");
    expect(normalizeScopePath("/a/./b")).toBe("/a/b");
    expect(normalizeScopePath("/a/b/../b/c")).toBe("/a/b/c");
    expect(normalizeScopePath("/a//b")).toBe("/a/b");
  });

  it("isWithin: equality is a match (subtree root itself)", () => {
    expect(isWithin("/Users/me/proj", "/Users/me/proj")).toBe(true);
  });

  it("isWithin: nested paths match", () => {
    expect(isWithin("/Users/me/proj/sub", "/Users/me/proj")).toBe(true);
    expect(isWithin("/Users/me/proj/sub/deep", "/Users/me/proj")).toBe(true);
  });

  it("isWithin: sibling with common name prefix does not match", () => {
    expect(isWithin("/Users/me/proj-sub", "/Users/me/proj")).toBe(false);
    expect(isWithin("/Users/me/projold", "/Users/me/proj")).toBe(false);
  });

  it("isWithin: parent of the root does not match (scope looks downward)", () => {
    expect(isWithin("/Users/me", "/Users/me/proj")).toBe(false);
  });

  it("isWithin: null cwd never matches (FR-004)", () => {
    expect(isWithin(null, "/Users/me/proj")).toBe(false);
    expect(isWithin(null, "/")).toBe(false);
  });

  it("isWithin: normalization applies to both sides (FR-008)", () => {
    expect(isWithin("/Users/me/proj/", "/Users/me/proj")).toBe(true);
    expect(isWithin("/Users/me/proj/sub", "/Users/me/proj/../proj")).toBe(true);
    expect(isWithin("/Users/me/proj/sub/", "/Users/me/proj/")).toBe(true);
  });

  it("isWithin: root / matches every non-null absolute cwd", () => {
    expect(isWithin("/tmp/scratch", "/")).toBe(true);
    expect(isWithin(null, "/")).toBe(false);
  });
});
