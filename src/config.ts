import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type Config = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  language?: string;
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

export const writeConfig = async (config: Config): Promise<string> => {
  const path = getConfigPath();
  const dir = join(path, "..");
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  return path;
};
