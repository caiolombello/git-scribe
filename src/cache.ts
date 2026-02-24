import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getGitDir } from "./git";
import { debugLog } from "./logging";
import type { CacheConfig } from "./config";

type CachedMessage = {
  subject: string;
  body?: string;
  timestamp: number;
};

const DEFAULT_MAX_AGE_DAYS = 14;
const DEFAULT_MAX_ENTRIES = 200;

const resolveCacheConfig = (config?: CacheConfig): Required<CacheConfig> => {
  const maxAgeDays = typeof config?.maxAgeDays === "number" && config.maxAgeDays > 0
    ? config.maxAgeDays
    : DEFAULT_MAX_AGE_DAYS;
  const maxEntries = typeof config?.maxEntries === "number" && config.maxEntries > 0
    ? Math.floor(config.maxEntries)
    : DEFAULT_MAX_ENTRIES;
  return { maxAgeDays, maxEntries };
};

const getCacheDir = async (repoRoot: string): Promise<string> => {
  const gitDir = await getGitDir(repoRoot);
  const normalized = gitDir.startsWith("/") ? gitDir : join(repoRoot, gitDir);
  return join(normalized, "git-scribe-cache");
};

const hashDiff = (diff: string): string => createHash("sha256").update(diff).digest("hex").slice(0, 16);

export const getCachedMessage = async (repoRoot: string, diff: string): Promise<CachedMessage | null> => {
  const hash = hashDiff(diff);
  const path = join(await getCacheDir(repoRoot), `${hash}.json`);
  try {
    const data = await readFile(path, "utf8");
    const now = new Date();
    void utimes(path, now, now).catch(() => undefined);
    return JSON.parse(data) as CachedMessage;
  } catch {
    return null;
  }
};

export const setCachedMessage = async (repoRoot: string, diff: string, message: { subject: string; body?: string }, config?: CacheConfig): Promise<void> => {
  const hash = hashDiff(diff);
  const dir = await getCacheDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${hash}.json`);
  await writeFile(path, JSON.stringify({ ...message, timestamp: Date.now() }, null, 2), "utf8");
  void pruneCache(repoRoot, config).catch((err) => {
    debugLog(`[cache] prune failed: ${err instanceof Error ? err.message : String(err)}`);
  });
};

export const pruneCache = async (repoRoot: string, config?: CacheConfig): Promise<void> => {
  const { maxAgeDays, maxEntries } = resolveCacheConfig(config);
  const dir = await getCacheDir(repoRoot);
  let entries: { path: string; mtimeMs: number }[] = [];

  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const candidates: { path: string; mtimeMs: number }[] = [];

    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith(".json")) {
        continue;
      }
      const path = join(dir, dirent.name);
      try {
        const stats = await stat(path);
        const mtimeMs = stats.mtimeMs;
        if (now - mtimeMs > maxAgeMs) {
          await unlink(path);
          continue;
        }
        candidates.push({ path, mtimeMs });
      } catch {
        continue;
      }
    }

    entries = candidates;
  } catch {
    return;
  }

  if (entries.length <= maxEntries) {
    return;
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toRemove = entries.slice(maxEntries);
  for (const entry of toRemove) {
    try {
      await unlink(entry.path);
    } catch {
      continue;
    }
  }
};
