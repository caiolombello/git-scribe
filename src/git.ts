import { spawn } from "bun";

export type FileStatus = {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  originalPath?: string;
};

type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const runGit = async (args: string[], cwd?: string): Promise<RunResult> => {
  const proc = spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
};

const runGitInteractive = async (args: string[], cwd?: string): Promise<number> => {
  const proc = spawn(["git", ...args], {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  });

  return proc.exited;
};

const assertGit = async (args: string[], cwd?: string): Promise<string> => {
  const result = await runGit(args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
};

export const getRepoRoot = async (cwd: string): Promise<string> => {
  const out = await assertGit(["rev-parse", "--show-toplevel"], cwd);
  return out.trim();
};

export const getStatus = async (cwd: string): Promise<FileStatus[]> => {
  const out = await assertGit(["status", "--porcelain=v1", "-z"], cwd);
  const entries = out.split("\0").filter(Boolean);
  const files: FileStatus[] = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.length < 3) {
      continue;
    }
    const indexStatus = entry.slice(0, 1);
    const worktreeStatus = entry.slice(1, 2);
    const path = entry.slice(3);
    const isRename = indexStatus === "R" || worktreeStatus === "R" || indexStatus === "C" || worktreeStatus === "C";

    if (isRename) {
      const newPath = entries[i + 1];
      files.push({ path: newPath, indexStatus, worktreeStatus, originalPath: path });
      i += 1;
      continue;
    }

    files.push({ path, indexStatus, worktreeStatus });
  }

  return files;
};

export const getDiffStat = async (cwd: string, staged: boolean, files?: string[]): Promise<string> => {
  const args = ["diff", ...(staged ? ["--cached"] : []), "--stat", "--"];
  if (files && files.length > 0) {
    args.push(...files);
  }
  return assertGit(args, cwd);
};

export const getDiff = async (cwd: string, staged: boolean, files?: string[]): Promise<string> => {
  const args = ["diff", ...(staged ? ["--cached"] : []), "-U0", "--"];
  if (files && files.length > 0) {
    args.push(...files);
  }
  return assertGit(args, cwd);
};

export const addFiles = async (cwd: string, files: string[]): Promise<void> => {
  if (files.length === 0) {
    return;
  }
  await assertGit(["add", "--", ...files], cwd);
};

export const addFilesInteractive = async (cwd: string, files: string[]): Promise<void> => {
  if (files.length === 0) {
    return;
  }
  const code = await runGitInteractive(["add", "-p", "--", ...files], cwd);
  if (code !== 0) {
    throw new Error("git add -p failed.");
  }
};

export const restoreStagedFiles = async (cwd: string, files: string[]): Promise<void> => {
  if (files.length === 0) {
    return;
  }
  await assertGit(["restore", "--staged", "--", ...files], cwd);
};

export const commitFiles = async (cwd: string, files: string[], subject: string, body?: string): Promise<void> => {
  const args = ["commit", "-m", subject];
  if (body && body.trim().length > 0) {
    args.push("-m", body.trim());
  }
  if (files.length > 0) {
    args.push("--", ...files);
  }
  await assertGit(args, cwd);
};

export const getShortStatus = async (cwd: string, files: string[]): Promise<string> => {
  if (files.length === 0) {
    return "";
  }
  const out = await assertGit(["status", "--short", "--", ...files], cwd);
  return out.trim();
};

export const hasStagedChanges = async (cwd: string, files: string[]): Promise<boolean> => {
  if (files.length === 0) {
    return false;
  }
  const out = await assertGit(["diff", "--cached", "--name-only", "--", ...files], cwd);
  return out.trim().length > 0;
};
