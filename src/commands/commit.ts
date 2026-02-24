import {
  addFiles,
  addFilesInteractive,
  amendCommit,
  commitFiles,
  getDiff,
  getDiffStat,
  getLastCommitMessage,
  getRecentCommits,
  getRepoRoot,
  getShortStatus,
  getStatus,
  hasStagedChanges,
  restoreStagedFiles
} from "../git";
import { generateCommitMessage } from "../openai";
import { multiSelect, promptMessageEdit, promptYesNo, singleSelect } from "../ui";
import { getCachedMessage, setCachedMessage, pruneCache } from "../cache";
import { detectMonorepoScope, validateConventionalCommit } from "../validation";
import { Group, FileEntry, groupByDirectory, proposeGroups, sanitizeGroups, toFileEntries } from "../grouping";
import type { ResolvedConfig } from "../config";
import { debugLog } from "../logging";

const DEFAULT_MAX_DIFF_CHARS = 20000;
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".webp", ".svg", ".tiff", ".psd", ".ai",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".tgz", ".xz",
  ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".flac", ".ogg", ".webm", ".m4a",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".o", ".a",
  ".db", ".sqlite", ".sqlite3",
  ".lock", ".lockb", ".yarn-integrity", ".pnp.cjs"
]);

const IGNORED_PATHS = [
  "node_modules/", ".git/", "dist/", "build/", ".next/", ".nuxt/", ".output/", "vendor/", "__pycache__/", ".venv/", "venv/", ".cache/", ".turbo/"
];

const shouldIgnoreFile = (path: string): boolean => {
  if (IGNORED_PATHS.some((segment) => path.includes(segment))) return true;
  const dotIndex = path.lastIndexOf(".");
  if (dotIndex === -1) return false;
  const ext = path.slice(dotIndex).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
};

const truncate = (value: string, maxChars: number): string => {
  if (maxChars <= 0) {
    return value;
  }
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars) + "\n[truncated]";
};

const resolveApiKey = (configApiKey?: string): string => {
  const apiKey = process.env.OPENAI_API_KEY ?? configApiKey;
  if (!apiKey) {
    throw new Error("OpenAI API key not found. Set OPENAI_API_KEY or configure it in git-scribe.");
  }
  return apiKey;
};

const buildCommitInput = async (
  cwd: string,
  files: string[],
  staged: boolean,
  maxDiffChars: number,
  recentCommits?: string
): Promise<string> => {
  const textFiles = files.filter((file) => !shouldIgnoreFile(file));
  const ignoredFiles = files.filter((file) => shouldIgnoreFile(file));

  const status = await getShortStatus(cwd, files);
  const stat = await getDiffStat(cwd, staged, textFiles);
  const patch = await getDiff(cwd, staged, textFiles);

  const parts = ["Selected files:", status || files.join("\n")];

  if (ignoredFiles.length > 0) {
    parts.push(`\nIgnored from diff (${ignoredFiles.length}): ${ignoredFiles.slice(0, 5).join(", ")}${ignoredFiles.length > 5 ? "..." : ""}`);
  }

  parts.push("\nDiffstat:", stat || "(empty)");

  if (patch.length > maxDiffChars * 2) {
    parts.push("\n[patch omitted - too large, using diffstat only]");
  } else {
    parts.push("\nPatch:", truncate(patch, maxDiffChars));
  }

  if (recentCommits) {
    parts.unshift("Recent commits (for style reference):", recentCommits, "");
  }

  return parts.join("\n");
};

const generateMessage = async (
  input: string,
  config: ResolvedConfig,
  modelOverride?: string,
  scopeOverride?: string
): Promise<{ subject: string; body?: string }> => {
  const apiKey = resolveApiKey(config.apiKey);
  const model = modelOverride ?? process.env.OPENAI_MODEL ?? config.model;
  const baseUrl = process.env.OPENAI_BASE_URL ?? config.baseUrl;
  const language = process.env.OPENAI_LANGUAGE ?? config.language;

  const scopeHint = scopeOverride ? `\nUse scope: ${scopeOverride}` : "";
  const modifiedInput = scopeHint ? input + scopeHint : input;

  return generateCommitMessage({ apiKey, model, baseUrl, input: modifiedInput, language, retry: config.retry });
};

type CommitOptions = {
  useHunks: boolean;
  dryRun: boolean;
  auto: boolean;
  batch: boolean;
  modelOverride?: string;
  scopeOverride?: string;
  maxDiffChars: number;
  noCache: boolean;
  interactive: boolean;
  maxFilesForAi?: number;
  maxFilesPerGroup?: number;
  config: ResolvedConfig;
  repoRoot: string;
};

const promptIfInteractive = async (interactive: boolean, fallback: boolean, message: string, defaultValue: boolean): Promise<boolean> => {
  if (!interactive) {
    return fallback;
  }
  return promptYesNo(message, defaultValue);
};

const pickFiles = async (label: string, files: FileEntry[], pageSize: number): Promise<string[] | null> => {
  const items = files.map((file) => ({
    label: `${file.path} (${file.status})`,
    value: file.path
  }));
  const selected = await multiSelect(label, items, new Set(items.map((_, idx) => idx)), { pageSize });
  if (!selected) {
    return null;
  }
  return selected.map((index) => items[index]?.value).filter(Boolean);
};

const pickGroup = async (label: string, groups: Group[], pageSize: number): Promise<Group | null> => {
  const items = groups.map((group) => ({
    label: `${group.name} (${group.files.length})`,
    value: group.name,
    details: group.files
  }));
  const selectedIndex = await singleSelect(label, items, { pageSize });
  if (selectedIndex === null) {
    return null;
  }
  return groups[selectedIndex] ?? null;
};

const commitFlow = async (cwd: string, files: string[], options: CommitOptions): Promise<boolean> => {
  if (files.length === 0) {
    return false;
  }

  if (!options.dryRun) {
    if (options.useHunks) {
      await addFilesInteractive(cwd, files);
      const hasStaged = await hasStagedChanges(cwd, files);
      if (!hasStaged) {
        console.log("No staged changes selected.");
        return false;
      }
    } else {
      await addFiles(cwd, files);
    }
  }

  const recentCommits = await getRecentCommits(cwd);
  const input = await buildCommitInput(cwd, files, !options.dryRun, options.maxDiffChars, recentCommits);

  let suggestion: { subject: string; body?: string };
  const useCache = !options.noCache && !options.scopeOverride;

  try {
    if (useCache) {
      const cached = await getCachedMessage(options.repoRoot, input);
      if (cached) {
        suggestion = cached;
        debugLog("[cache] using cached message");
      } else {
        const scope = options.scopeOverride ?? await detectMonorepoScope(cwd, files);
        suggestion = await generateMessage(input, options.config, options.modelOverride, scope ?? undefined);
        await setCachedMessage(options.repoRoot, input, suggestion, options.config.cache);
      }
    } else {
      const scope = options.scopeOverride ?? await detectMonorepoScope(cwd, files);
      suggestion = await generateMessage(input, options.config, options.modelOverride, scope ?? undefined);
    }
  } catch (err) {
    if (!options.dryRun) {
      await restoreStagedFiles(cwd, files);
    }
    throw err;
  }

  const validation = validateConventionalCommit(suggestion.subject);
  if (!validation.valid) {
    console.log("\nWarning: Message validation issues:");
    validation.errors.forEach((e) => console.log(`  - ${e}`));
  }

  const shouldPrompt = options.interactive && !options.auto;
  const edited = shouldPrompt ? await promptMessageEdit(suggestion.subject, suggestion.body) : suggestion;
  if (!edited) {
    if (!options.dryRun) {
      const undo = await promptIfInteractive(shouldPrompt, true, "Unstage selected files?", true);
      if (undo) {
        await restoreStagedFiles(cwd, files);
      }
    }
    return false;
  }

  if (edited.subject !== suggestion.subject) {
    const editedValidation = validateConventionalCommit(edited.subject);
    if (!editedValidation.valid) {
      console.log("\nWarning: Edited message has issues:");
      editedValidation.errors.forEach((e) => console.log(`  - ${e}`));
      const proceed = await promptIfInteractive(shouldPrompt, true, "Continue anyway?", false);
      if (!proceed) {
        return false;
      }
    }
  }

  if (options.dryRun) {
    console.log("\nCommit message preview:");
    console.log(edited.subject);
    if (edited.body && edited.body.trim().length > 0) {
      console.log("\n" + edited.body.trim());
    }
    return true;
  }

  const proceed = await promptIfInteractive(shouldPrompt, true, "Create commit now?", true);
  if (!proceed) {
    const undo = await promptIfInteractive(shouldPrompt, true, "Unstage selected files?", true);
    if (undo) {
      await restoreStagedFiles(cwd, files);
    }
    return false;
  }

  await commitFiles(cwd, files, edited.subject, edited.body);
  return true;
};

export type CommitCommandOptions = {
  mode?: "single" | "manual" | "ai";
  useHunks: boolean;
  dryRun: boolean;
  auto: boolean;
  batch: boolean;
  modelOverride?: string;
  scopeOverride?: string;
  maxDiffChars?: number;
  noCache: boolean;
  interactive: boolean;
  maxFilesForAi?: number;
  maxFilesPerGroup?: number;
};

export const runCommitCommand = async (cwd: string, config: ResolvedConfig, options: CommitCommandOptions): Promise<void> => {
  const repoRoot = await getRepoRoot(cwd);
  if (!options.noCache) {
    void pruneCache(repoRoot, config.cache).catch(() => undefined);
  }

  const resolvedMaxDiffChars = options.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;
  if (Number.isNaN(resolvedMaxDiffChars)) {
    throw new Error("Invalid value for --max-diff-chars");
  }

  const status = await getStatus(repoRoot);
  const entries = toFileEntries(status);

  if (entries.length === 0) {
    console.log("No changes detected.");
    return;
  }

  const validModes = new Set(["single", "manual", "ai"]);
  const resolvedMode = options.mode && validModes.has(options.mode) ? options.mode : undefined;
  let mode = resolvedMode;
  if (!mode) {
    const modeIndex = await singleSelect("Select mode", [
      { label: "Single commit", value: "single" },
      { label: "Multiple commits (manual grouping)", value: "manual" },
      { label: "Multiple commits (AI grouping)", value: "ai" }
    ], { pageSize: config.ui.pageSize });
    if (modeIndex === null) {
      return;
    }
    mode = ["single", "manual", "ai"][modeIndex] as "single" | "manual" | "ai";
  }

  const commitOptions: CommitOptions = {
    useHunks: options.useHunks,
    dryRun: options.dryRun,
    auto: options.auto,
    batch: options.batch,
    modelOverride: options.modelOverride,
    scopeOverride: options.scopeOverride,
    maxDiffChars: resolvedMaxDiffChars,
    noCache: options.noCache,
    interactive: options.interactive,
    maxFilesForAi: options.maxFilesForAi,
    maxFilesPerGroup: options.maxFilesPerGroup,
    config,
    repoRoot
  };

  if (mode === "single") {
    const selected = await pickFiles("Select files to include", entries, config.ui.pageSize);
    if (!selected || selected.length === 0) {
      return;
    }
    await commitFlow(repoRoot, selected, commitOptions);
    return;
  }

  const effectiveBatch = options.batch || !options.interactive;
  let remaining = [...entries];
  while (remaining.length > 0) {
    if (mode === "manual") {
      const selected = await pickFiles("Pick files for next commit", remaining, config.ui.pageSize);
      if (!selected || selected.length === 0) {
        return;
      }
      const committed = await commitFlow(repoRoot, selected, commitOptions);
      if (committed) {
        remaining = remaining.filter((entry) => !selected.includes(entry.path));
      }
      continue;
    }

    const stagedStat = await getDiffStat(repoRoot, true).catch(() => "");
    const unstagedStat = await getDiffStat(repoRoot, false).catch(() => "");
    const stat = [stagedStat, unstagedStat].filter(Boolean).join("\n");
    let groups: Group[];

    try {
      const suggested = await proposeGroups({
        files: remaining,
        diffStat: stat,
        apiKey: resolveApiKey(config.apiKey),
        model: options.modelOverride ?? process.env.OPENAI_MODEL ?? config.model,
        baseUrl: process.env.OPENAI_BASE_URL ?? config.baseUrl,
        maxFilesForAi: options.maxFilesForAi ?? config.grouping.maxFilesForAi,
        maxFilesPerGroup: options.maxFilesPerGroup ?? config.grouping.maxFilesPerGroup
      });
      groups = sanitizeGroups(suggested, new Set(remaining.map((entry) => entry.path)));
      if (groups.length === 0) {
        throw new Error("Empty group list.");
      }
    } catch (err) {
      const fallback = await promptIfInteractive(options.interactive && !options.auto, true, "AI grouping failed. Use directory grouping instead?", true);
      if (!fallback) {
        return;
      }
      groups = groupByDirectory(remaining);
    }

    const group = effectiveBatch ? groups[0] : await pickGroup("Pick a group to commit", groups, config.ui.pageSize);
    if (!group) {
      return;
    }

    if (effectiveBatch) {
      console.log(`Committing: ${group.name} (${group.files.length} files)`);
    }

    const committed = await commitFlow(repoRoot, group.files, commitOptions);
    if (committed) {
      remaining = remaining.filter((entry) => !group.files.includes(entry.path));
    }

    if (remaining.length > 0) {
      const continueLoop = await promptIfInteractive(options.interactive && !options.auto, true, "Create another commit?", true);
      if (!continueLoop) {
        return;
      }
    }
  }

  console.log("Done.");
};

export const runAmendCommand = async (
  cwd: string,
  config: ResolvedConfig,
  options: CommitCommandOptions
): Promise<void> => {
  const repoRoot = await getRepoRoot(cwd);
  const lastMsg = await getLastCommitMessage(repoRoot);
  const recentCommits = await getRecentCommits(repoRoot);
  const diff = await getDiff(repoRoot, false);
  const stat = await getDiffStat(repoRoot, false);
  const maxDiffChars = options.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;

  const input = [
    "Recent commits (for style reference):",
    recentCommits,
    "",
    "Current commit message:",
    lastMsg.subject,
    lastMsg.body ? `\n${lastMsg.body}` : "",
    "\nDiffstat:",
    stat || "(empty)",
    "\nPatch:",
    truncate(diff, maxDiffChars)
  ].join("\n");

  const scope = options.scopeOverride ?? await detectMonorepoScope(repoRoot, []);
  const suggestion = await generateMessage(input, config, options.modelOverride, scope ?? undefined);

  const validation = validateConventionalCommit(suggestion.subject);
  if (!validation.valid) {
    console.log("\nWarning: Message validation issues:");
    validation.errors.forEach((e) => console.log(`  - ${e}`));
  }

  const shouldPrompt = options.interactive && !options.auto;
  const edited = shouldPrompt ? await promptMessageEdit(suggestion.subject, suggestion.body) : suggestion;
  if (!edited) {
    return;
  }

  if (options.dryRun) {
    console.log("\nAmended commit message preview:");
    console.log(edited.subject);
    if (edited.body?.trim()) console.log("\n" + edited.body.trim());
    return;
  }

  const proceed = await promptIfInteractive(shouldPrompt, true, "Amend commit now?", true);
  if (proceed) {
    await amendCommit(repoRoot, edited.subject, edited.body);
    console.log("Commit amended.");
  }
};
