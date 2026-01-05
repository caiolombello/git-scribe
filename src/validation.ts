import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";

type PackageJson = {
  name?: string;
  workspaces?: string[] | { packages?: string[] };
};

const readPackageJson = async (dir: string): Promise<PackageJson | null> => {
  try {
    const data = await readFile(join(dir, "package.json"), "utf8");
    return JSON.parse(data) as PackageJson;
  } catch {
    return null;
  }
};

export const detectMonorepoScope = async (repoRoot: string, files: string[]): Promise<string | null> => {
  const rootPkg = await readPackageJson(repoRoot);
  if (!rootPkg?.workspaces) return null;

  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    if (parts.length >= 2) dirs.add(parts.slice(0, 2).join("/"));
  }

  for (const dir of dirs) {
    const pkg = await readPackageJson(join(repoRoot, dir));
    if (pkg?.name) {
      const name = pkg.name.startsWith("@") ? pkg.name.split("/")[1] : pkg.name;
      return name ?? null;
    }
  }

  return null;
};

const VALID_TYPES = new Set([
  "feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"
]);

const COMMIT_REGEX = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

export const validateConventionalCommit = (subject: string): ValidationResult => {
  const errors: string[] = [];
  const match = subject.match(COMMIT_REGEX);

  if (!match) {
    return { valid: false, errors: ["Invalid format. Expected: type(scope): description"] };
  }

  const [, type, , , description] = match;

  if (!VALID_TYPES.has(type)) {
    errors.push(`Invalid type "${type}". Valid: ${[...VALID_TYPES].join(", ")}`);
  }

  if (subject.length > 72) {
    errors.push(`Subject too long (${subject.length}/72 chars)`);
  }

  if (!description || description.length === 0) {
    errors.push("Description is required");
  }

  if (description && description[0] === description[0].toUpperCase() && description[0] !== description[0].toLowerCase()) {
    errors.push("Description should start with lowercase");
  }

  if (subject.endsWith(".")) {
    errors.push("Subject should not end with a period");
  }

  return { valid: errors.length === 0, errors };
};
