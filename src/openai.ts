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
  retry?: RetryConfig;
};

type OpenAIMessage = {
  subject: string;
  body?: string;
};

const extractText = (payload: unknown): string => {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const record = payload as { output?: Array<{ content?: Array<{ type: string; text?: string }> }> };
  const parts: string[] = [];

  for (const item of record.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" || content.type === "summary_text") {
        if (content.text) {
          parts.push(content.text);
        }
      }
    }
  }

  return parts.join("\n").trim();
};

const extractJson = (text: string): OpenAIMessage | null => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  const slice = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as OpenAIMessage;
    if (!parsed.subject) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
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

export const requestText = async (options: OpenAIOptions): Promise<string> => {
  const { maxRetries = 3, baseDelay = 1000, maxDelay = 30000, timeout = 60000 } = options.retry ?? {};
  
  const body = {
    model: options.model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: "You are a precise assistant. Follow the user instructions and return only the requested format."
          }
        ]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: options.input }]
      }
    ],
    max_output_tokens: 400
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(
        `${options.baseUrl}/v1/responses`,
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
        return extractText(payload);
      }

      const status = response.status;
      const errText = await response.text();
      lastError = new Error(`OpenAI error: ${status} ${errText}`);

      if (status !== 429 && status < 500) {
        throw lastError;
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

  const text = await requestText({ ...options, input });
  const parsed = extractJson(text);

  if (!parsed) {
    throw new Error("Failed to parse OpenAI response.");
  }

  return parsed;
};
