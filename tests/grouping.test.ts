import { describe, expect, test } from "bun:test";
import { groupByDirectory, parseGroupJson, sanitizeGroups, type FileEntry } from "../src/grouping";

describe("grouping", () => {
  test("groupByDirectory groups by first segment", () => {
    const files: FileEntry[] = [
      { path: "src/a.ts", status: "M" },
      { path: "src/b.ts", status: "A" },
      { path: "docs/readme.md", status: "M" },
      { path: "root.md", status: "M" }
    ];

    const groups = groupByDirectory(files);
    const names = groups.map((group) => group.name).sort();
    expect(names).toEqual(["docs", "root", "src"]);
  });

  test("parseGroupJson handles fenced output", () => {
    const text = "```json\n[{\"name\":\"core\",\"files\":[\"a.ts\"]}]\n```";
    const parsed = parseGroupJson(text);
    expect(parsed?.[0]?.name).toBe("core");
  });

  test("sanitizeGroups removes duplicates", () => {
    const groups = [
      { name: "one", files: ["a.ts", "b.ts"] },
      { name: "two", files: ["b.ts", "c.ts"] }
    ];
    const cleaned = sanitizeGroups(groups, new Set(["a.ts", "b.ts", "c.ts"]));
    expect(cleaned[0].files).toEqual(["a.ts", "b.ts"]);
    expect(cleaned[1].files).toEqual(["c.ts"]);
  });
});
