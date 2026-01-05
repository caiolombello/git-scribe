import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type CachedMessage = {
  subject: string;
  body?: string;
  timestamp: number;
};

const getCacheDir = (repoRoot: string): string => join(repoRoot, ".git", "git-scribe-cache");

const hashDiff = (diff: string): string => createHash("sha256").update(diff).digest("hex").slice(0, 16);

export const getCachedMessage = async (repoRoot: string, diff: string): Promise<CachedMessage | null> => {
  const hash = hashDiff(diff);
  const path = join(getCacheDir(repoRoot), `${hash}.json`);
  try {
    const data = await readFile(path, "utf8");
    return JSON.parse(data) as CachedMessage;
  } catch {
    return null;
  }
};

export const setCachedMessage = async (repoRoot: string, diff: string, message: { subject: string; body?: string }): Promise<void> => {
  const hash = hashDiff(diff);
  const dir = getCacheDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${hash}.json`);
  await writeFile(path, JSON.stringify({ ...message, timestamp: Date.now() }, null, 2), "utf8");
};
