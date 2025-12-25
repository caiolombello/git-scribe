import {
  getRepoRoot,
  getStatus,
  getDiffStat,
  getDiff,
  addFiles,
  addFilesInteractive,
  restoreStagedFiles,
  commitFiles,
  getShortStatus,
  hasStagedChanges
} from "./git";
import { getConfigPath, loadConfig, writeConfig } from "./config";
import { generateCommitMessage, requestText } from "./openai";
import { multiSelect, promptMessageEdit, promptYesNo, singleSelect, promptText, SelectItemType } from "./ui";

type Group = {
  name: string;
  files: string[];
};

type FileEntry = {
  path: string;
  status: string;
};

const DEFAULT_MAX_DIFF_CHARS = 20000;
const DEFAULT_MODEL = "gpt-5.1-codex-mini";

const truncate = (value: string, maxChars: number): string => {
  if (maxChars <= 0) {
    return value;
  }
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars) + "\n[truncated]";
};

const toFileEntries = (files: Awaited<ReturnType<typeof getStatus>>): FileEntry[] =>
  files.map((file) => {
    const status = `${file.indexStatus}${file.worktreeStatus}`.trim();
    return {
      path: file.path,
      status: status || "??"
    };
  });

const resolveApiKey = (configApiKey?: string): string => {
  const apiKey = process.env.OPENAI_API_KEY ?? configApiKey;
  if (!apiKey) {
    throw new Error(`OpenAI API key not found. Set OPENAI_API_KEY or add it to ${getConfigPath()}.`);
  }
  return apiKey;
};

const extractGroupJson = (text: string): Group[] | null => {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  const slice = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as Group[];
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const buildCommitInput = async (cwd: string, files: string[], staged: boolean, maxDiffChars: number): Promise<string> => {
  const status = await getShortStatus(cwd, files);
  const stat = await getDiffStat(cwd, staged, files);
  const patch = await getDiff(cwd, staged, files);

  return [
    "Selected files:",
    status || files.join("\n"),
    "\nDiffstat:",
    stat || "(empty)",
    "\nPatch:",
    truncate(patch, maxDiffChars)
  ].join("\n");
};

const generateMessage = async (
  input: string,
  config: { apiKey?: string; model?: string; baseUrl?: string; language?: string },
  modelOverride?: string
): Promise<{ subject: string; body?: string }> => {
  const apiKey = resolveApiKey(config.apiKey);
  const model = modelOverride ?? process.env.OPENAI_MODEL ?? config.model ?? DEFAULT_MODEL;
  const baseUrl = process.env.OPENAI_BASE_URL ?? config.baseUrl ?? "https://api.openai.com";
  const language = process.env.OPENAI_LANGUAGE ?? config.language;

  return generateCommitMessage({ apiKey, model, baseUrl, input, language });
};

const proposeGroups = async (
  files: FileEntry[],
  diffStat: string,
  config: { apiKey?: string; model?: string; baseUrl?: string; language?: string },
  modelOverride?: string
): Promise<Group[]> => {
  const apiKey = resolveApiKey(config.apiKey);
  const model = modelOverride ?? process.env.OPENAI_MODEL ?? config.model ?? DEFAULT_MODEL;
  const baseUrl = process.env.OPENAI_BASE_URL ?? config.baseUrl ?? "https://api.openai.com";

  const input = [
    "You are grouping files into multiple Conventional Commits.",
    "Return JSON only: [{\"name\":\"short name\",\"files\":[\"path\"]}].",
    "Use only the provided file paths. Avoid overlap.",
    "\nFiles:",
    ...files.map((file) => `- ${file.path} (${file.status})`),
    "\nDiffstat:",
    diffStat || "(empty)"
  ].join("\n");

  const text = await requestText({ apiKey, model, baseUrl, input });
  const parsed = extractGroupJson(text);
  if (parsed && parsed.length > 0) {
    return parsed;
  }

  throw new Error("Failed to parse group suggestions.");
};

const groupByDirectory = (files: FileEntry[]): Group[] => {
  const map = new Map<string, string[]>();
  for (const file of files) {
    const segment = file.path.includes("/") ? file.path.split("/")[0] : "root";
    const list = map.get(segment) ?? [];
    list.push(file.path);
    map.set(segment, list);
  }

  return [...map.entries()].map(([name, list]) => ({ name, files: list }));
};

const sanitizeGroups = (groups: Group[], allowed: Set<string>): Group[] => {
  const seen = new Set<string>();
  const cleaned: Group[] = [];

  for (const group of groups) {
    const files = (group.files || []).filter((file) => allowed.has(file) && !seen.has(file));
    if (files.length === 0) {
      continue;
    }
    files.forEach((file) => seen.add(file));
    cleaned.push({ name: group.name || "group", files });
  }

  return cleaned;
};

const pickFiles = async (label: string, files: FileEntry[]): Promise<string[] | null> => {
  const items: SelectItemType[] = files.map((file) => ({
    label: `${file.path} (${file.status})`,
    value: file.path
  }));

  const selected = await multiSelect(label, items, new Set(items.map((_, idx) => idx)));
  if (!selected) {
    return null;
  }

  return selected.map((index) => items[index]?.value).filter(Boolean);
};

const pickGroup = async (label: string, groups: Group[]): Promise<Group | null> => {
  const items: SelectItemType[] = groups.map((group) => ({
    label: `${group.name} (${group.files.length})`,
    value: group.name,
    details: group.files
  }));

  const selectedIndex = await singleSelect(label, items);
  if (selectedIndex === null) {
    return null;
  }

  return groups[selectedIndex] ?? null;
};

type CommitOptions = {
  useHunks: boolean;
  dryRun: boolean;
  auto: boolean;
  modelOverride?: string;
  maxDiffChars: number;
  config: { apiKey?: string; model?: string; baseUrl?: string; language?: string };
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

  const input = await buildCommitInput(cwd, files, !options.dryRun, options.maxDiffChars);
  let suggestion: { subject: string; body?: string };

  try {
    suggestion = await generateMessage(input, options.config, options.modelOverride);
  } catch (err) {
    if (!options.dryRun) {
      await restoreStagedFiles(cwd, files);
    }
    throw err;
  }

  const edited = options.auto ? suggestion : await promptMessageEdit(suggestion.subject, suggestion.body);
  if (!edited) {
    if (!options.dryRun) {
      const undo = await promptYesNo("Unstage selected files?", true);
      if (undo) {
        await restoreStagedFiles(cwd, files);
      }
    }
    return false;
  }

  if (options.dryRun) {
    console.log("\nCommit message preview:");
    console.log(edited.subject);
    if (edited.body && edited.body.trim().length > 0) {
      console.log("\n" + edited.body.trim());
    }
    return true;
  }

  const proceed = options.auto ? true : await promptYesNo("Create commit now?", true);
  if (!proceed) {
    const undo = await promptYesNo("Unstage selected files?", true);
    if (undo) {
      await restoreStagedFiles(cwd, files);
    }
    return false;
  }

  await commitFiles(cwd, files, edited.subject, edited.body);
  return true;
};

const getFlag = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
};

const hasFlag = (args: string[], flag: string): boolean => args.includes(flag);

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(
      [
        "git-scribe usage:",
        "  init",
        "  --mode <single|manual|ai>",
        "  --dry-run",
        "  --hunks",
        "  --auto",
        "  --model <name>",
        "  --max-diff-chars <n>"
      ].join("\n")
    );
    return;
  }

  if (args[0] === "init") {
    const existing = await loadConfig();
    if (existing.apiKey || existing.model || existing.baseUrl || existing.language) {
      const overwrite = await promptYesNo("Config already exists. Overwrite?", false);
      if (!overwrite) {
        return;
      }
    }
    const apiKey = await promptText("OpenAI API key: ");
    const model = await promptText(`Model (${DEFAULT_MODEL}): `);
    const baseUrl = await promptText("Base URL (https://api.openai.com): ");
    const language = await promptText("Language for commit messages (e.g., Portuguese, English, Spanish): ");
    const path = await writeConfig({
      apiKey: apiKey || undefined,
      model: model || undefined,
      baseUrl: baseUrl || undefined,
      language: language || undefined
    });
    console.log(`Config written to ${path}`);
    return;
  }

  const cwd = process.cwd();
  const repoRoot = await getRepoRoot(cwd);
  const status = await getStatus(repoRoot);
  const entries = toFileEntries(status);
  const config = await loadConfig();

  if (entries.length === 0) {
    console.log("No changes detected.");
    return;
  }

  const modeArg = getFlag(args, "--mode");
  const useHunks = hasFlag(args, "--hunks");
  const dryRun = hasFlag(args, "--dry-run");
  const auto = hasFlag(args, "--auto");
  const modelOverride = getFlag(args, "--model");
  const maxDiffRaw = getFlag(args, "--max-diff-chars");
  const maxDiffChars = maxDiffRaw ? Number(maxDiffRaw) : DEFAULT_MAX_DIFF_CHARS;
  if (Number.isNaN(maxDiffChars)) {
    throw new Error("Invalid value for --max-diff-chars");
  }

  const validModes = new Set(["single", "manual", "ai"]);
  const resolvedMode = modeArg && validModes.has(modeArg) ? modeArg : undefined;
  let mode = resolvedMode;
  if (!mode) {
    const modeIndex = await singleSelect("Select mode", [
      { label: "Single commit", value: "single" },
      { label: "Multiple commits (manual grouping)", value: "manual" },
      { label: "Multiple commits (AI grouping)", value: "ai" }
    ]);
    if (modeIndex === null) {
      return;
    }
    mode = ["single", "manual", "ai"][modeIndex];
  }

  const options: CommitOptions = {
    useHunks,
    dryRun,
    auto,
    modelOverride: modelOverride || undefined,
    maxDiffChars,
    config
  };
  if (mode === "single") {
    const selected = await pickFiles("Select files to include", entries);
    if (!selected || selected.length === 0) {
      return;
    }
    await commitFlow(repoRoot, selected, options);
    return;
  }

  let remaining = [...entries];
  while (remaining.length > 0) {
    if (mode === "manual") {
      const selected = await pickFiles("Pick files for next commit", remaining);
      if (!selected || selected.length === 0) {
        return;
      }
      const committed = await commitFlow(repoRoot, selected, options);
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
      const suggested = await proposeGroups(remaining, stat, config, modelOverride || undefined);
      groups = sanitizeGroups(suggested, new Set(remaining.map((entry) => entry.path)));
      if (groups.length === 0) {
        throw new Error("Empty group list.");
      }
    } catch (err) {
      const fallback = await promptYesNo("AI grouping failed. Use directory grouping instead?", true);
      if (!fallback) {
        return;
      }
      groups = groupByDirectory(remaining);
    }

    const group = await pickGroup("Pick a group to commit", groups);
    if (!group) {
      return;
    }

    const committed = await commitFlow(repoRoot, group.files, options);
    if (committed) {
      remaining = remaining.filter((entry) => !group.files.includes(entry.path));
    }

    if (remaining.length > 0) {
      const continueLoop = options.auto ? true : await promptYesNo("Create another commit?", true);
      if (!continueLoop) {
        return;
      }
    }
  }

  console.log("Done.");
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
