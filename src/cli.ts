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
  hasStagedChanges,
  getRecentCommits,
  getLastCommitMessage,
  amendCommit
} from "./git";
import { getConfigPath, loadConfig, writeConfig } from "./config";
import { generateCommitMessage, requestText } from "./openai";
import { multiSelect, promptMessageEdit, promptYesNo, singleSelect, promptText, SelectItemType } from "./ui";
import { getCachedMessage, setCachedMessage } from "./cache";
import { detectMonorepoScope, validateConventionalCommit } from "./validation";

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
const MAX_FILES_FOR_GROUPING = 30;
const BINARY_EXTENSIONS = new Set([
  // Imagens
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".webp", ".svg", ".tiff", ".psd", ".ai",
  // Fontes
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  // Documentos
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt",
  // Arquivos compactados
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".tgz", ".xz",
  // Áudio/Vídeo
  ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".flac", ".ogg", ".webm", ".m4a",
  // Executáveis/Binários
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".o", ".a",
  // Databases
  ".db", ".sqlite", ".sqlite3",
  // Outros
  ".lock", ".lockb", ".yarn-integrity", ".pnp.cjs"
]);

const IGNORED_PATHS = ["node_modules/", ".git/", "dist/", "build/", ".next/", ".nuxt/", ".output/", "vendor/", "__pycache__/", ".venv/", "venv/", ".cache/", ".turbo/"];

const shouldIgnoreFile = (path: string): boolean => {
  if (IGNORED_PATHS.some((p) => path.includes(p))) return true;
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
};

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

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

const buildCommitInput = async (cwd: string, files: string[], staged: boolean, maxDiffChars: number, recentCommits?: string): Promise<string> => {
  const textFiles = files.filter((f) => !shouldIgnoreFile(f));
  const ignoredFiles = files.filter((f) => shouldIgnoreFile(f));
  
  const status = await getShortStatus(cwd, files);
  const stat = await getDiffStat(cwd, staged, textFiles);
  const patch = await getDiff(cwd, staged, textFiles);

  const parts = [
    "Selected files:",
    status || files.join("\n")
  ];

  if (ignoredFiles.length > 0) {
    parts.push(`\nIgnored from diff (${ignoredFiles.length}): ${ignoredFiles.slice(0, 5).join(", ")}${ignoredFiles.length > 5 ? "..." : ""}`);
  }

  parts.push("\nDiffstat:", stat || "(empty)");

  // Se patch muito grande, omitir e usar só diffstat
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
  config: { apiKey?: string; model?: string; baseUrl?: string; language?: string; retry?: { maxRetries?: number; baseDelay?: number; maxDelay?: number; timeout?: number } },
  modelOverride?: string,
  scopeOverride?: string
): Promise<{ subject: string; body?: string }> => {
  const apiKey = resolveApiKey(config.apiKey);
  const model = modelOverride ?? process.env.OPENAI_MODEL ?? config.model ?? DEFAULT_MODEL;
  const baseUrl = process.env.OPENAI_BASE_URL ?? config.baseUrl ?? "https://api.openai.com";
  const language = process.env.OPENAI_LANGUAGE ?? config.language;

  const scopeHint = scopeOverride ? `\nUse scope: ${scopeOverride}` : "";
  const modifiedInput = scopeHint ? input + scopeHint : input;

  return generateCommitMessage({ apiKey, model, baseUrl, input: modifiedInput, language, retry: config.retry });
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

  // Se muitos arquivos, processar em batches e agrupar por diretório primeiro
  if (files.length > MAX_FILES_FOR_GROUPING) {
    console.log(`Large changeset (${files.length} files). Using directory-based pre-grouping...`);
    const dirGroups = groupByDirectory(files);
    const allGroups: Group[] = [];

    for (const dirGroup of dirGroups) {
      if (dirGroup.files.length <= 5) {
        allGroups.push(dirGroup);
        continue;
      }

      // Subdividir grupos grandes com IA
      const subFiles = files.filter((f) => dirGroup.files.includes(f.path));
      const subInput = [
        "Group these related files into logical Conventional Commits.",
        "Return JSON only: [{\"name\":\"short name\",\"files\":[\"path\"]}].",
        "\nFiles:",
        ...subFiles.map((f) => `- ${f.path} (${f.status})`)
      ].join("\n");

      try {
        const text = await requestText({ apiKey, model, baseUrl, input: subInput });
        const parsed = extractGroupJson(text);
        if (parsed && parsed.length > 0) {
          allGroups.push(...parsed);
        } else {
          allGroups.push(dirGroup);
        }
      } catch {
        allGroups.push(dirGroup);
      }
    }

    return allGroups;
  }

  // Fluxo normal para poucos arquivos
  const input = [
    "You are grouping files into multiple Conventional Commits.",
    "Return JSON only: [{\"name\":\"short name\",\"files\":[\"path\"]}].",
    "Use only the provided file paths. Avoid overlap.",
    "\nFiles:",
    ...files.map((file) => `- ${file.path} (${file.status})`),
    diffStat ? `\nDiffstat:\n${diffStat}` : ""
  ].join("\n");

  const tokens = estimateTokens(input);
  if (tokens > 3000) {
    console.log(`Warning: Large input (~${tokens} tokens). Response may be incomplete.`);
  }

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
  scopeOverride?: string;
  repoRoot: string;
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
  
  // Check cache
  const cached = await getCachedMessage(options.repoRoot, input);
  let suggestion: { subject: string; body?: string };

  if (cached && !options.scopeOverride) {
    suggestion = cached;
    console.log("Using cached message...");
  } else {
    // Detect monorepo scope if not overridden
    const scope = options.scopeOverride ?? await detectMonorepoScope(cwd, files);
    
    try {
      suggestion = await generateMessage(input, options.config, options.modelOverride, scope ?? undefined);
      await setCachedMessage(options.repoRoot, input, suggestion);
    } catch (err) {
      if (!options.dryRun) {
        await restoreStagedFiles(cwd, files);
      }
      throw err;
    }
  }

  // Validate message
  const validation = validateConventionalCommit(suggestion.subject);
  if (!validation.valid) {
    console.log("\nWarning: Message validation issues:");
    validation.errors.forEach((e) => console.log(`  - ${e}`));
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

  // Validate edited message
  if (edited.subject !== suggestion.subject) {
    const editedValidation = validateConventionalCommit(edited.subject);
    if (!editedValidation.valid) {
      console.log("\nWarning: Edited message has issues:");
      editedValidation.errors.forEach((e) => console.log(`  - ${e}`));
      const proceed = await promptYesNo("Continue anyway?", false);
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
        "  --batch",
        "  --model <name>",
        "  --max-diff-chars <n>",
        "  --scope <name>",
        "  --amend"
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
  const config = await loadConfig();

  const modeArg = getFlag(args, "--mode");
  const useHunks = hasFlag(args, "--hunks");
  const dryRun = hasFlag(args, "--dry-run");
  const auto = hasFlag(args, "--auto");
  const modelOverride = getFlag(args, "--model");
  const scopeOverride = getFlag(args, "--scope");
  const isAmend = hasFlag(args, "--amend");
  const isBatch = hasFlag(args, "--batch");
  const maxDiffRaw = getFlag(args, "--max-diff-chars");
  const maxDiffChars = maxDiffRaw ? Number(maxDiffRaw) : DEFAULT_MAX_DIFF_CHARS;
  if (Number.isNaN(maxDiffChars)) {
    throw new Error("Invalid value for --max-diff-chars");
  }

  // Handle --amend mode
  if (isAmend) {
    const lastMsg = await getLastCommitMessage(repoRoot);
    const recentCommits = await getRecentCommits(repoRoot);
    const diff = await getDiff(repoRoot, false);
    const stat = await getDiffStat(repoRoot, false);
    
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

    const scope = scopeOverride ?? await detectMonorepoScope(repoRoot, []);
    const suggestion = await generateMessage(input, config, modelOverride, scope ?? undefined);
    
    const validation = validateConventionalCommit(suggestion.subject);
    if (!validation.valid) {
      console.log("\nWarning: Message validation issues:");
      validation.errors.forEach((e) => console.log(`  - ${e}`));
    }

    const edited = auto ? suggestion : await promptMessageEdit(suggestion.subject, suggestion.body);
    if (!edited) return;

    if (dryRun) {
      console.log("\nAmended commit message preview:");
      console.log(edited.subject);
      if (edited.body?.trim()) console.log("\n" + edited.body.trim());
      return;
    }

    const proceed = auto ? true : await promptYesNo("Amend commit now?", true);
    if (proceed) {
      await amendCommit(repoRoot, edited.subject, edited.body);
      console.log("Commit amended.");
    }
    return;
  }

  const status = await getStatus(repoRoot);
  const entries = toFileEntries(status);

  if (entries.length === 0) {
    console.log("No changes detected.");
    return;
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
    config,
    scopeOverride: scopeOverride || undefined,
    repoRoot
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

    const group = isBatch ? groups[0] : await pickGroup("Pick a group to commit", groups);
    if (!group) {
      return;
    }

    if (isBatch) {
      console.log(`Committing: ${group.name} (${group.files.length} files)`);
    }

    const committed = await commitFlow(repoRoot, group.files, options);
    if (committed) {
      remaining = remaining.filter((entry) => !group.files.includes(entry.path));
    }

    if (remaining.length > 0) {
      const continueLoop = (options.auto || isBatch) ? true : await promptYesNo("Create another commit?", true);
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
