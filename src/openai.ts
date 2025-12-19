type OpenAIOptions = {
  apiKey: string;
  model: string;
  baseUrl: string;
  input: string;
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

export const requestText = async (options: OpenAIOptions): Promise<string> => {
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

  const response = await fetch(`${options.baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI error: ${response.status} ${errText}`);
  }

  const payload = (await response.json()) as unknown;
  return extractText(payload);
};

export const generateCommitMessage = async (options: OpenAIOptions): Promise<OpenAIMessage> => {
  const input = [
    "Write a Conventional Commit message.",
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
