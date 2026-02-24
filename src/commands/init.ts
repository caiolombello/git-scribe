import { DEFAULT_BASE_URL, DEFAULT_MODEL, loadConfig, writeConfig } from "../config";
import { promptText, promptYesNo } from "../ui";

export const runInitCommand = async (): Promise<void> => {
  const existing = await loadConfig();
  if (existing.apiKey || existing.model || existing.baseUrl || existing.language) {
    const overwrite = await promptYesNo("Config already exists. Overwrite?", false);
    if (!overwrite) {
      return;
    }
  }

  const apiKey = await promptText("OpenAI API key: ");
  const model = await promptText(`Model (${DEFAULT_MODEL}): `);
  const baseUrl = await promptText(`Base URL (${DEFAULT_BASE_URL}): `);
  const language = await promptText("Language for commit messages (e.g., Portuguese, English, Spanish): ");

  const path = await writeConfig({
    apiKey: apiKey || undefined,
    model: model || undefined,
    baseUrl: baseUrl || undefined,
    language: language || undefined
  });

  console.log(`Config written to ${path}`);
};
