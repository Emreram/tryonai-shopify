// gpt-5.4-mini wrapper — the "thinking" model for the AI Outfit Stylist
// (owner-specified). Used for outfit selection and product slot classification
// via the Responses API with STRUCTURED OUTPUTS (schema-bound JSON), plus an
// optional image-input path for product color analysis. Kept separate from
// openai.server.ts (which owns gpt-image-2 try-on generation).

import OpenAI from "openai";

export const OUTFIT_TEXT_MODEL = process.env.OUTFIT_TEXT_MODEL || "gpt-5.4-mini";

type ReasoningEffort = "minimal" | "low" | "medium" | "high";

function reasoningEffort(): ReasoningEffort {
  const raw = (process.env.OUTFIT_REASONING_EFFORT || "low").toLowerCase();
  if (raw === "minimal" || raw === "low" || raw === "medium" || raw === "high") {
    return raw;
  }
  return "low";
}

// gpt-5.4-mini pricing per token (verify against https://openai.com/api/pricing/
// before deploy): input $0.75/1M, cached input $0.075/1M, output $4.50/1M.
// NOTE: reasoning tokens are billed as OUTPUT tokens and are already included in
// usage.output_tokens, so they are covered by the output rate below.
const TEXT_MODEL_RATES = {
  inputPerToken: 0.75 / 1_000_000,
  cachedInputPerToken: 0.075 / 1_000_000,
  outputPerToken: 4.5 / 1_000_000,
} as const;

export interface TextUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
  output_tokens_details?: { reasoning_tokens?: number } | null;
}

export function computeTextCostUsd(usage: TextUsage | null | undefined): number {
  if (!usage) return 0;
  const input = usage.input_tokens ?? 0;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const billedInput = Math.max(0, input - cached);
  const output = usage.output_tokens ?? 0; // includes reasoning tokens
  return (
    billedInput * TEXT_MODEL_RATES.inputPerToken +
    cached * TEXT_MODEL_RATES.cachedInputPerToken +
    output * TEXT_MODEL_RATES.outputPerToken
  );
}

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    client = new OpenAI({ apiKey, timeout: 60_000 });
  }
  return client;
}

export interface StructuredResult<T> {
  data: T;
  usage: TextUsage | null;
  requestId: string | null;
}

export interface StructuredRequest {
  /** System-level instructions (role + constraints). */
  instructions: string;
  /** The user prompt (the data + the ask). */
  input: string;
  /** Optional image URLs to attach (color-vision path). */
  imageUrls?: string[];
  /** JSON Schema the model output is bound to (strict mode). */
  schema: Record<string, unknown>;
  /** A short name for the schema, e.g. "outfit". */
  schemaName: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

/**
 * Run a single structured-output completion. Returns the parsed object (typed by
 * the caller via <T>) plus token usage for COGS. Throws on transport/parse error
 * so callers can fall back deterministically.
 */
export async function runStructured<T>({
  instructions,
  input,
  imageUrls,
  schema,
  schemaName,
  maxOutputTokens = 3000,
  signal,
}: StructuredRequest): Promise<StructuredResult<T>> {
  const openai = getClient();

  const content: Array<Record<string, unknown>> = [
    { type: "input_text", text: input },
  ];
  for (const url of imageUrls ?? []) {
    content.push({ type: "input_image", image_url: url });
  }

  // Typed loosely against the SDK to stay robust across minor Responses API
  // shape changes; the schema + parse below are what actually guard the data.
  const params = {
    model: OUTFIT_TEXT_MODEL,
    instructions,
    input: [{ role: "user", content }],
    reasoning: { effort: reasoningEffort() },
    max_output_tokens: maxOutputTokens,
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        schema,
        strict: true,
      },
    },
  };

  const response = await openai.responses.create(
    params as unknown as Parameters<typeof openai.responses.create>[0],
    signal ? { signal } : undefined,
  );

  const text = extractOutputText(response);
  if (!text) throw new Error("gpt-5.4-mini returned no output text");

  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch (err) {
    throw new Error(
      `gpt-5.4-mini output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const usage = (response as { usage?: TextUsage | null }).usage ?? null;
  const requestId =
    (response as { _request_id?: string | null })._request_id ?? null;
  return { data, usage, requestId };
}

// `output_text` is the SDK convenience accessor; fall back to walking the output
// array if a given SDK version doesn't expose it.
function extractOutputText(response: unknown): string {
  const direct = (response as { output_text?: unknown }).output_text;
  if (typeof direct === "string" && direct.length > 0) return direct;

  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    const contentArr = (item as { content?: unknown }).content;
    if (!Array.isArray(contentArr)) continue;
    for (const c of contentArr) {
      const t = (c as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("").trim();
}
