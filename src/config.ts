import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type RetryConfig = {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  timeout?: number;
};

export type CacheConfig = {
  maxAgeDays?: number;
  maxEntries?: number;
};

export type GroupingConfig = {
  maxFilesForAi?: number;
  maxFilesPerGroup?: number;
};

export type UiConfig = {
  pageSize?: number;
};

export type Config = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  language?: string;
  retry?: RetryConfig;
  cache?: CacheConfig;
  grouping?: GroupingConfig;
  ui?: UiConfig;
  debug?: boolean;
};

export type ResolvedConfig = {
  apiKey?: string;
  model: string;
  baseUrl: string;
  language?: string;
  retry: Required<RetryConfig>;
  cache: Required<CacheConfig>;
  grouping: Required<GroupingConfig>;
  ui: Required<UiConfig>;
  debug: boolean;
};

export const DEFAULT_MODEL = "gpt-5.1-codex-mini";
export const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_RETRY: Required<RetryConfig> = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  timeout: 60000
};
const DEFAULT_CACHE: Required<CacheConfig> = {
  maxAgeDays: 14,
  maxEntries: 200
};
const DEFAULT_GROUPING: Required<GroupingConfig> = {
  maxFilesForAi: 30,
  maxFilesPerGroup: 25
};
const DEFAULT_UI: Required<UiConfig> = {
  pageSize: 12
};

export const getConfigPath = (): string => {
  const configRoot = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configRoot, "git-scribe", "config.json");
};

export const loadConfig = async (): Promise<Config> => {
  const path = getConfigPath();
  try {
    const data = await readFile(path, "utf8");
    const parsed = JSON.parse(data) as Config;
    return parsed ?? {};
  } catch {
    return {};
  }
};

const toNumber = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return fallback;
};

const toBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
};

export const resolveConfig = (config: Config): ResolvedConfig => {
  const retry = config.retry ?? {};
  const cache = config.cache ?? {};
  const grouping = config.grouping ?? {};
  const ui = config.ui ?? {};

  return {
    apiKey: typeof config.apiKey === "string" ? config.apiKey : undefined,
    model: typeof config.model === "string" && config.model ? config.model : DEFAULT_MODEL,
    baseUrl: typeof config.baseUrl === "string" && config.baseUrl ? config.baseUrl : DEFAULT_BASE_URL,
    language: typeof config.language === "string" && config.language ? config.language : undefined,
    retry: {
      maxRetries: Math.max(1, Math.floor(toNumber(retry.maxRetries, DEFAULT_RETRY.maxRetries))),
      baseDelay: Math.max(100, toNumber(retry.baseDelay, DEFAULT_RETRY.baseDelay)),
      maxDelay: Math.max(1000, toNumber(retry.maxDelay, DEFAULT_RETRY.maxDelay)),
      timeout: Math.max(1000, toNumber(retry.timeout, DEFAULT_RETRY.timeout))
    },
    cache: {
      maxAgeDays: Math.max(1, Math.floor(toNumber(cache.maxAgeDays, DEFAULT_CACHE.maxAgeDays))),
      maxEntries: Math.max(10, Math.floor(toNumber(cache.maxEntries, DEFAULT_CACHE.maxEntries)))
    },
    grouping: {
      maxFilesForAi: Math.max(5, Math.floor(toNumber(grouping.maxFilesForAi, DEFAULT_GROUPING.maxFilesForAi))),
      maxFilesPerGroup: Math.max(5, Math.floor(toNumber(grouping.maxFilesPerGroup, DEFAULT_GROUPING.maxFilesPerGroup)))
    },
    ui: {
      pageSize: Math.max(5, Math.floor(toNumber(ui.pageSize, DEFAULT_UI.pageSize)))
    },
    debug: toBoolean(config.debug, false)
  };
};

export const writeConfig = async (config: Config): Promise<string> => {
  const path = getConfigPath();
  const dir = join(path, "..");
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  return path;
};
