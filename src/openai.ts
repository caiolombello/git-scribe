import { debugLog, isDebugEnabled } from "./logging";

type RetryConfig = {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  timeout?: number;
};

type OpenAIOptions = {
  apiKey: string;
  model: string;
  baseUrl: string;
  input: string;
  language?: string;
  responseFormat?: "json_object";
  maxOutputTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  retry?: RetryConfig;
};

type OpenAIMessage = {
  subject: string;
  body?: string;
};

const truncateForLog = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars) + "\n[truncated]";
};

const extractText = (payload: unknown): string => {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const record = payload as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string; json?: unknown }> }>;
    choices?: Array<{ message?: { content?: string } }>;
  };

  if (typeof record.output_text === "string") {
    return record.output_text.trim();
  }

  if (Array.isArray(record.output)) {
    const parts: string[] = [];
    for (const item of record.output) {
      if (!item || !Array.isArray(item.content)) {
        continue;
      }
      for (const content of item.content) {
        if (!content) {
          continue;
        }
        if (content.type === "output_json" && content.json !== undefined) {
          return JSON.stringify(content.json).trim();
        }
        if (typeof content.text === "string") {
          parts.push(content.text);
        }
      }
    }
    if (parts.length > 0) {
      return parts.join("").trim();
    }
  }

  if (record.choices && record.choices.length > 0) {
    const firstChoice = record.choices[0];
    if (firstChoice.message && firstChoice.message.content) {
      return firstChoice.message.content.trim();
    }
  }

  return "";
};

const extractErrorMessage = (payload: unknown): string | null => {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as { error?: { message?: string } };
  if (record.error && typeof record.error.message === "string") {
    return record.error.message;
  }
  return null;
};

const extractIncompleteReason = (payload: unknown): string | null => {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as { status?: string; incomplete_details?: { reason?: string } };
  if (record.status === "incomplete" && record.incomplete_details && typeof record.incomplete_details.reason === "string") {
    return record.incomplete_details.reason;
  }
  return null;
};

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

const tryParseJson = (value: string): OpenAIMessage | null => {
  try {
    const parsed = JSON.parse(value) as OpenAIMessage;
    if (!parsed || typeof parsed !== "object" || !parsed.subject) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const extractJson = (text: string): OpenAIMessage | null => {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const direct = tryParseJson(trimmed);
  if (direct) {
    return direct;
  }

  const unfenced = stripCodeFences(trimmed);
  if (unfenced !== trimmed) {
    const unfencedParsed = tryParseJson(unfenced);
    if (unfencedParsed) {
      return unfencedParsed;
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  const slice = trimmed.slice(start, end + 1);
  return tryParseJson(slice);
};

const fetchWithTimeout = async (url: string, init: RequestInit, timeout: number): Promise<Response> => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
};

const resolveEndpoints = (baseUrl: string): { responsesUrl: string; chatUrl: string } => {
  const trimmed = baseUrl.replace(/\/+$/, "");

  if (/\/chat\/completions$/i.test(trimmed)) {
    if (/\/v1\/chat\/completions$/i.test(trimmed)) {
      return {
        chatUrl: trimmed,
        responsesUrl: trimmed.replace(/\/chat\/completions$/i, "/responses")
      };
    }

    const root = trimmed.replace(/\/chat\/completions$/i, "");
    return {
      chatUrl: `${root}/v1/chat/completions`,
      responsesUrl: `${root}/v1/responses`
    };
  }

  if (/\/responses$/i.test(trimmed)) {
    if (/\/v1\/responses$/i.test(trimmed)) {
      return {
        responsesUrl: trimmed,
        chatUrl: trimmed.replace(/\/responses$/i, "/chat/completions")
      };
    }

    const root = trimmed.replace(/\/responses$/i, "");
    return {
      responsesUrl: `${root}/v1/responses`,
      chatUrl: `${root}/v1/chat/completions`
    };
  }

  if (/\/v1$/i.test(trimmed)) {
    return {
      responsesUrl: `${trimmed}/responses`,
      chatUrl: `${trimmed}/chat/completions`
    };
  }

  return {
    responsesUrl: `${trimmed}/v1/responses`,
    chatUrl: `${trimmed}/v1/chat/completions`
  };
};

const isOpenAIBaseUrl = (baseUrl: string): boolean => {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return host === "api.openai.com" || host.endsWith(".openai.com");
  } catch {
    return baseUrl.toLowerCase().includes("openai.com");
  }
};

export const requestText = async (options: OpenAIOptions): Promise<string> => {
  const { maxRetries = 3, baseDelay = 1000, maxDelay = 30000, timeout = 60000 } = options.retry ?? {};
  const responseFormat = options.responseFormat;
  const baseMaxOutputTokens = options.maxOutputTokens ?? 800;
  const reasoningEffort = options.reasoningEffort ?? "low";

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const { responsesUrl, chatUrl } = resolveEndpoints(options.baseUrl);
      if (isDebugEnabled()) {
        debugLog(`[openai] responsesUrl=${responsesUrl}`);
        debugLog(`[openai] chatUrl=${chatUrl}`);
        debugLog(`[openai] model=${options.model}`);
      }

      const maxOutputTokens = Math.min(baseMaxOutputTokens * (attempt + 1), 2000);
      const chatBody = {
        model: options.model,
        messages: [
          {
            role: "system",
            content: "You are a precise assistant. Follow the user instructions and return only the requested format."
          },
          {
            role: "user",
            content: options.input
          }
        ],
        max_tokens: maxOutputTokens,
        ...(responseFormat ? { response_format: { type: responseFormat } } : {})
      };

      const responsesBody = {
        model: options.model,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: "You are a precise assistant. Follow the user instructions and return only the requested format." }]
          },
          {
            role: "user",
            content: [{ type: "input_text", text: options.input }]
          }
        ],
        max_output_tokens: maxOutputTokens,
        ...(responseFormat ? { text: { format: { type: responseFormat } } } : {}),
        ...(isOpenAIBaseUrl(options.baseUrl) ? { reasoning: { effort: reasoningEffort } } : {})
      };

      const tryRequest = async (url: string, body: unknown) => {
        const response = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${options.apiKey}`
            },
            body: JSON.stringify(body)
          },
          timeout
        );

        if (response.ok) {
          const payload = (await response.json()) as unknown;
          const errorMessage = extractErrorMessage(payload);
          if (errorMessage) {
            if (isDebugEnabled()) {
              debugLog("OpenAI raw payload (error in 2xx):");
              debugLog(truncateForLog(JSON.stringify(payload, null, 2), 4000));
            }
            return { ok: false, text: "", status: response.status, errText: errorMessage, payload } as const;
          }

          const extracted = extractText(payload);
          if (isDebugEnabled() && extracted.trim().length === 0) {
            debugLog("OpenAI raw payload (empty extract):");
            debugLog(truncateForLog(JSON.stringify(payload, null, 2), 4000));
          }

          return { ok: true, text: extracted, status: response.status, errText: "", payload } as const;
        }

        const errText = await response.text();
        return { ok: false, text: "", status: response.status, errText, payload: null } as const;
      };

      const responseResult = await tryRequest(responsesUrl, responsesBody);
      if (responseResult.ok) {
        const trimmed = responseResult.text.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }

        const incompleteReason = extractIncompleteReason(responseResult.payload);
        if (incompleteReason) {
          lastError = new Error(`OpenAI response incomplete (${incompleteReason}).`);
        } else {
          lastError = new Error("OpenAI returned empty response.");
        }
        continue;
      }

      const fallbackText = responseResult.errText.toLowerCase();
      const shouldFallback = responseResult.status === 404
        || fallbackText.includes("unknown endpoint")
        || fallbackText.includes("not found")
        || fallbackText.includes("not supported")
        || fallbackText.includes("unsupported")
        || fallbackText.includes("no route");

      const allowFallback = !isOpenAIBaseUrl(options.baseUrl);

      if (shouldFallback && allowFallback) {
        const chatResult = await tryRequest(chatUrl, chatBody);
        if (chatResult.ok) {
          const trimmed = chatResult.text.trim();
          if (trimmed.length > 0) {
            return trimmed;
          }
          lastError = new Error("OpenAI returned empty response.");
          continue;
        }

        const status = chatResult.status;
        lastError = new Error(`OpenAI error: ${status} ${chatResult.errText}`);
        if (status !== 429 && status < 500) {
          throw lastError;
        }
      } else {
        const status = responseResult.status;
        lastError = new Error(`OpenAI error: ${status} ${responseResult.errText}`);
        if (status !== 429 && status < 500) {
          throw lastError;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        lastError = new Error(`Request timeout after ${timeout}ms`);
      } else if (err instanceof Error) {
        lastError = err;
      }
      if (lastError && !lastError.message.includes("429") && !lastError.message.includes("5")) {
        if (!(lastError.message.includes("timeout") || lastError.message.includes("ECONNRESET"))) {
          throw lastError;
        }
      }
    }

    const jitter = Math.random() * 0.3 + 0.85; // 0.85-1.15
    const delay = Math.min(baseDelay * Math.pow(2, attempt) * jitter, maxDelay);
    await new Promise((r) => setTimeout(r, delay));
  }

  throw lastError ?? new Error("Request failed after retries");
};

export const generateCommitMessage = async (options: OpenAIOptions): Promise<OpenAIMessage> => {
  const languageInstruction = options.language 
    ? `Write the commit message in ${options.language}.`
    : "Write a Conventional Commit message.";
  
  const input = [
    languageInstruction,
    "Return JSON only: {\"subject\":\"type(scope): summary\",\"body\":\"optional body\"}.",
    "Keep subject <= 72 chars, imperative, no trailing period. Omit scope if unknown.",
    "",
    options.input
  ].join("\n");

  const text = await requestText({ ...options, input, responseFormat: "json_object" });
  const parsed = extractJson(text);

  if (!parsed) {
    if (isDebugEnabled()) {
      debugLog("OpenAI raw response (commit message):");
      debugLog(truncateForLog(text, 4000));
    }
    throw new Error("Failed to parse OpenAI response.");
  }

  return parsed;
};
