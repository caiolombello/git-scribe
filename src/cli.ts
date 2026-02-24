import packageJson from "../package.json" assert { type: "json" };
import { resolveConfig, loadConfig, DEFAULT_BASE_URL, DEFAULT_MODEL } from "./config";
import { runInitCommand } from "./commands/init";
import { runAmendCommand, runCommitCommand } from "./commands/commit";

const VERSION = typeof packageJson.version === "string" ? packageJson.version : "unknown";

const getFlag = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
};

const hasFlag = (args: string[], flag: string): boolean => args.includes(flag);

const parseNumberFlag = (args: string[], flag: string): number | undefined => {
  const raw = getFlag(args, flag);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid value for ${flag}`);
  }
  return value;
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (hasFlag(args, "--version") || hasFlag(args, "-v") || args[0] === "version") {
    console.log(`git-scribe ${VERSION}`);
    return;
  }

  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(
      [
        "git-scribe usage:",
        "  init",
        "  version",
        "  --mode <single|manual|ai>",
        "  --dry-run",
        "  --hunks",
        "  --auto",
        "  --batch",
        "  --model <name>",
        "  --max-diff-chars <n>",
        "  --scope <name>",
        "  --amend",
        "  --no-cache",
        "  --no-interactive",
        "  --max-files-ai <n>",
        "  --max-files-group <n>",
        "  --debug",
        "  --version, -v",
        "",
        `Defaults: model=${DEFAULT_MODEL}, baseUrl=${DEFAULT_BASE_URL}`
      ].join("\n")
    );
    return;
  }

  if (args[0] === "init") {
    await runInitCommand();
    return;
  }

  const config = resolveConfig(await loadConfig());

  if (config.debug || hasFlag(args, "--debug")) {
    process.env.GIT_SCRIBE_DEBUG = "1";
  }

  if (hasFlag(args, "--no-interactive")) {
    process.env.GIT_SCRIBE_NON_INTERACTIVE = "1";
  }

  const mode = getFlag(args, "--mode") as "single" | "manual" | "ai" | undefined;
  const useHunks = hasFlag(args, "--hunks");
  const dryRun = hasFlag(args, "--dry-run");
  const auto = hasFlag(args, "--auto");
  const batch = hasFlag(args, "--batch");
  const modelOverride = getFlag(args, "--model");
  const scopeOverride = getFlag(args, "--scope");
  const isAmend = hasFlag(args, "--amend");
  const maxDiffChars = parseNumberFlag(args, "--max-diff-chars");
  const maxFilesForAi = parseNumberFlag(args, "--max-files-ai");
  const maxFilesPerGroup = parseNumberFlag(args, "--max-files-group");
  const noCache = hasFlag(args, "--no-cache");

  const interactive = !hasFlag(args, "--no-interactive") && Boolean(process.stdin.isTTY && process.stdout.isTTY);

  const commandOptions = {
    mode,
    useHunks,
    dryRun,
    auto,
    batch,
    modelOverride: modelOverride || undefined,
    scopeOverride: scopeOverride || undefined,
    maxDiffChars,
    noCache,
    interactive,
    maxFilesForAi,
    maxFilesPerGroup
  };

  if (isAmend) {
    await runAmendCommand(process.cwd(), config, commandOptions);
    return;
  }

  await runCommitCommand(process.cwd(), config, commandOptions);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
