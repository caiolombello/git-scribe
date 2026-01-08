import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

type CachedMessage = {
  subject: string;
  body?: string;
  timestamp: number;
};

const getGitDir = async (repoRoot: string): Promise<string> => {
  const result = await $`git -C ${repoRoot} rev-parse --git-dir`.text();
  const gitDir = result.trim();
  return gitDir.startsWith("/") ? gitDir : join(repoRoot, gitDir);
};

const getCacheDir = async (repoRoot: string): Promise<string> => join(await getGitDir(repoRoot), "git-scribe-cache");

const hashDiff = (diff: string): string => createHash("sha256").update(diff).digest("hex").slice(0, 16);

export const getCachedMessage = async (repoRoot: string, diff: string): Promise<CachedMessage | null> => {
  const hash = hashDiff(diff);
  const path = join(await getCacheDir(repoRoot), `${hash}.json`);
  try {
    const data = await readFile(path, "utf8");
    return JSON.parse(data) as CachedMessage;
  } catch {
    return null;
  }
};

export const setCachedMessage = async (repoRoot: string, diff: string, message: { subject: string; body?: string }): Promise<void> => {
  const hash = hashDiff(diff);
  const dir = await getCacheDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${hash}.json`);
  await writeFile(path, JSON.stringify({ ...message, timestamp: Date.now() }, null, 2), "utf8");
};
