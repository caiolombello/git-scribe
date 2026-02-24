import { describe, expect, test } from "bun:test";
import { validateConventionalCommit } from "../src/validation";

describe("validateConventionalCommit", () => {
  test("accepts valid subject", () => {
    const result = validateConventionalCommit("feat(cli): add version flag");
    expect(result.valid).toBe(true);
  });

  test("rejects invalid type", () => {
    const result = validateConventionalCommit("feature: add thing");
    expect(result.valid).toBe(false);
  });

  test("rejects long subject", () => {
    const result = validateConventionalCommit("feat: " + "a".repeat(80));
    expect(result.valid).toBe(false);
  });
});
