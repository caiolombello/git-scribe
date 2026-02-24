import { requestText } from "./openai";
import { debugLog } from "./logging";
import type { FileStatus } from "./git";

export type Group = {
  name: string;
  files: string[];
};

export type FileEntry = {
  path: string;
  status: string;
};

export type GroupingRequest = {
  files: FileEntry[];
  diffStat: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  maxFilesForAi: number;
  maxFilesPerGroup: number;
};

export const toFileEntries = (files: FileStatus[]): FileEntry[] =>
  files.map((file) => {
    const status = `${file.indexStatus}${file.worktreeStatus}`.trim();
    return {
      path: file.path,
      status: status || "??"
    };
  });

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const stripCodeFences = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  const lines = trimmed.split("\n");
  if (lines.length < 2) {
    return trimmed;
  }
  const fenceEnd = lines.lastIndexOf("```");
  if (fenceEnd > 0) {
    return lines.slice(1, fenceEnd).join("\n").trim();
  }
  return lines.slice(1).join("\n").trim();
};

const tryParseGroupJson = (value: string): Group[] | null => {
  try {
    const parsed = JSON.parse(value) as Group[];
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const parseGroupJson = (text: string): Group[] | null => {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const direct = tryParseGroupJson(trimmed);
  if (direct) {
    return direct;
  }

  const unfenced = stripCodeFences(trimmed);
  if (unfenced !== trimmed) {
    const unfencedParsed = tryParseGroupJson(unfenced);
    if (unfencedParsed) {
      return unfencedParsed;
    }
  }

  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return tryParseGroupJson(trimmed.slice(start, end + 1));
};

export const groupByDirectory = (files: FileEntry[]): Group[] => {
  const map = new Map<string, string[]>();
  for (const file of files) {
    const segment = file.path.includes("/") ? file.path.split("/")[0] : "root";
    const list = map.get(segment) ?? [];
    list.push(file.path);
    map.set(segment, list);
  }

  return [...map.entries()].map(([name, list]) => ({ name, files: list }));
};

const statusLabel = (status: string): string => {
  const trimmed = status.replace(/\s+/g, "");
  const flag = trimmed[0] ?? "?";
  switch (flag) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "?":
      return "untracked";
    default:
      return "updated";
  }
};

const groupByStatus = (files: FileEntry[]): Group[] => {
  const map = new Map<string, string[]>();
  for (const file of files) {
    const label = statusLabel(file.status);
    const list = map.get(label) ?? [];
    list.push(file.path);
    map.set(label, list);
  }

  return [...map.entries()].map(([name, list]) => ({ name, files: list }));
};

const chunkGroup = (group: Group, maxFilesPerGroup: number): Group[] => {
  if (group.files.length <= maxFilesPerGroup) {
    return [group];
  }
  const chunks: Group[] = [];
  for (let i = 0; i < group.files.length; i += maxFilesPerGroup) {
    const slice = group.files.slice(i, i + maxFilesPerGroup);
    const index = Math.floor(i / maxFilesPerGroup) + 1;
    const total = Math.ceil(group.files.length / maxFilesPerGroup);
    chunks.push({ name: `${group.name} ${index}/${total}`, files: slice });
  }
  return chunks;
};

const preGroupFiles = (files: FileEntry[], maxFilesPerGroup: number): Group[] => {
  const dirGroups = groupByDirectory(files);
  const expanded: Group[] = [];

  for (const dirGroup of dirGroups) {
    if (dirGroup.files.length <= maxFilesPerGroup) {
      expanded.push(dirGroup);
      continue;
    }

    const dirEntries = files.filter((file) => dirGroup.files.includes(file.path));
    const statusGroups = groupByStatus(dirEntries);
    if (statusGroups.length > 1) {
      for (const statusGroup of statusGroups) {
        const merged = { name: `${dirGroup.name}:${statusGroup.name}`, files: statusGroup.files };
        expanded.push(...chunkGroup(merged, maxFilesPerGroup));
      }
      continue;
    }

    expanded.push(...chunkGroup(dirGroup, maxFilesPerGroup));
  }

  return expanded;
};

export const sanitizeGroups = (groups: Group[], allowed: Set<string>): Group[] => {
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

const buildGroupPrompt = (files: FileEntry[], diffStat: string): string => [
  "You are grouping files into multiple Conventional Commits.",
  "Return JSON only: [{\"name\":\"short name\",\"files\":[\"path\"]}].",
  "Use only the provided file paths. Avoid overlap.",
  "\nFiles:",
  ...files.map((file) => `- ${file.path} (${file.status})`),
  diffStat ? `\nDiffstat:\n${diffStat}` : ""
].join("\n");

const buildSubGroupPrompt = (files: FileEntry[]): string => [
  "Group these related files into logical Conventional Commits.",
  "Return JSON only: [{\"name\":\"short name\",\"files\":[\"path\"]}].",
  "\nFiles:",
  ...files.map((file) => `- ${file.path} (${file.status})`)
].join("\n");

export const proposeGroups = async ({
  files,
  diffStat,
  apiKey,
  model,
  baseUrl,
  maxFilesForAi,
  maxFilesPerGroup
}: GroupingRequest): Promise<Group[]> => {
  const preGrouped = preGroupFiles(files, maxFilesPerGroup);

  if (files.length > maxFilesForAi) {
    const refined: Group[] = [];
    for (const group of preGrouped) {
      if (group.files.length <= 5 || group.files.length > maxFilesForAi) {
        refined.push(group);
        continue;
      }

      const subFiles = files.filter((file) => group.files.includes(file.path));
      const subInput = buildSubGroupPrompt(subFiles);
      try {
        const text = await requestText({ apiKey, model, baseUrl, input: subInput });
        const parsed = parseGroupJson(text);
        if (parsed && parsed.length > 0) {
          refined.push(...parsed);
        } else {
          refined.push(group);
        }
      } catch {
        refined.push(group);
      }
    }
    return refined;
  }

  const input = buildGroupPrompt(files, diffStat);
  const tokens = estimateTokens(input);
  if (tokens > 3000) {
    debugLog(`[grouping] warning: large input (~${tokens} tokens)`);
  }

  const text = await requestText({ apiKey, model, baseUrl, input });
  const parsed = parseGroupJson(text);
  if (parsed && parsed.length > 0) {
    return parsed;
  }

  return preGrouped;
};
