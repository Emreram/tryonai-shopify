// Structured-text model wrapper — the "thinking" model for the AI Outfit Stylist
// and the Size Recommender. Used for outfit selection and product slot
// classification with STRICT JSON-schema output, plus an optional image-input
// path for product color analysis. Kept separate from tryonModel.server.ts
// (which owns gpt-image-2 try-on generation).
//
// Runs on OpenRouter's Chat Completions API, NOT OpenAI's Responses API:
// OpenRouter's own surface is OpenAI-Chat-shaped, so `instructions` becomes a
// system message, `input_text`/`input_image` parts become `text`/`image_url`
// parts, and `text.format` becomes `response_format: { type: "json_schema" }`.
// Docs: https://openrouter.ai/docs/api_reference/overview
//       https://openrouter.ai/docs/guides/features/structured-outputs

import {
  OPENROUTER_CHAT_URL,
  ModelError,
  modelErrorFromResponse,
  openRouterHeaders,
} from "./openrouter.server";

/**
 * Model slug on OpenRouter (organisation prefix required). Overridable so the
 * text tier can be re-pointed without a code change.
 */
export const OUTFIT_TEXT_MODEL =
  process.env.OUTFIT_TEXT_MODEL || "openai/gpt-5.4-mini";

type ReasoningEffort = "minimal" | "low" | "medium" | "high";

function reasoningEffort(): ReasoningEffort {
  const raw = (process.env.OUTFIT_REASONING_EFFORT || "low").toLowerCase();
  if (raw === "minimal" || raw === "low" || raw === "medium" || raw === "high") {
    return raw;
  }
  return "low";
}

/**
 * Usage as reported by OpenRouter. `cost` is the authoritative USD charge, so
 * no local rate table is needed (and cannot drift out of date).
 */
export interface TextUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  cost?: number | null;
}

export function computeTextCostUsd(usage: TextUsage | null | undefined): number {
  return usage?.cost ?? 0;
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
 * the caller via <T>) plus usage for COGS. Throws on transport/parse error so
 * callers can fall back deterministically.
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
  const content: Array<Record<string, unknown>> = [{ type: "text", text: input }];
  for (const url of imageUrls ?? []) {
    content.push({ type: "image_url", image_url: { url } });
  }

  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: openRouterHeaders(),
    signal,
    body: JSON.stringify({
      model: OUTFIT_TEXT_MODEL,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content },
      ],
      reasoning: { effort: reasoningEffort() },
      max_tokens: maxOutputTokens,
      response_format: {
        type: "json_schema",
        json_schema: { name: schemaName, strict: true, schema },
      },
    }),
  });

  if (!response.ok) {
    throw await modelErrorFromResponse(response);
  }

  const body: unknown = await response.json();
  const text = extractMessageText(body);
  if (!text) {
    throw new ModelError({
      kind: "upstream",
      status: response.status,
      message: `${OUTFIT_TEXT_MODEL} returned no output text`,
    });
  }

  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch (err) {
    throw new Error(
      `${OUTFIT_TEXT_MODEL} output was not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return {
    data,
    usage: extractUsage(body),
    requestId: response.headers.get("x-request-id"),
  };
}

/** Reads `choices[0].message.content`, tolerating the array-of-parts form. */
function extractMessageText(body: unknown): string {
  if (typeof body !== "object" || body === null || !("choices" in body)) return "";
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";

  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null || !("message" in first)) {
    return "";
  }
  const message = first.message;
  if (typeof message !== "object" || message === null || !("content" in message)) {
    return "";
  }

  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "object" && part !== null && "text" in part) {
      if (typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("").trim();
}

function extractUsage(body: unknown): TextUsage | null {
  if (typeof body !== "object" || body === null || !("usage" in body)) return null;
  const usage = body.usage;
  if (typeof usage !== "object" || usage === null) return null;
  const num = (key: string): number | null => {
    const value: unknown = Reflect.get(usage, key);
    return typeof value === "number" ? value : null;
  };
  return {
    prompt_tokens: num("prompt_tokens"),
    completion_tokens: num("completion_tokens"),
    total_tokens: num("total_tokens"),
    cost: num("cost"),
  };
}
