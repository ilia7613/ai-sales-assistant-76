import "server-only";
import { CONSULTANT_MODEL } from "../consultant/config";
import type { ConversationMessage } from "../consultant/service";

export const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_MESSAGES = 100;
const MAX_TEXT_LENGTH = 10_000;
const MAX_OUTPUT_TOKENS = 4096;

export class RequestValidationError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

export type ElevenLabsResponsesRequest = {
  input: ConversationMessage[];
  maxOutputTokens: number;
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) {
    throw new RequestValidationError("Text must be a string of at most 10000 characters");
  }
  return value;
}

function content(value: unknown): string {
  if (typeof value === "string") return text(value);
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new RequestValidationError("Only text content is supported");
  }
  return text(value.map((part: unknown) => {
    if (!object(part) || (part.type !== "input_text" && part.type !== "output_text")) {
      throw new RequestValidationError("Only text content is supported");
    }
    return text(part.text);
  }).join(""));
}

export function validateResponsesRequest(value: unknown): ElevenLabsResponsesRequest {
  if (!object(value)) throw new RequestValidationError("Body must be an object");
  const allowed = new Set([
    "model", "stream", "input", "instructions", "tools", "tool_choice", "max_output_tokens",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new RequestValidationError("Unsupported request fields");
  }
  if (value.stream !== true) {
    throw new RequestValidationError("Only stream:true is supported");
  }
  if (value.model !== undefined && value.model !== CONSULTANT_MODEL) {
    throw new RequestValidationError("Unsupported model");
  }
  // File search is configured exclusively by the server. No caller tools in this MVP.
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.length !== 0)) {
    throw new RequestValidationError("Client-provided tools are not supported");
  }
  if (value.tool_choice !== undefined && value.tool_choice !== "auto") {
    throw new RequestValidationError("Only automatic server tool selection is supported");
  }
  // Agents may send instructions. Validate their size, but keep our own instructions.
  if (value.instructions !== undefined && value.instructions !== null) text(value.instructions);

  let input: ConversationMessage[];
  if (typeof value.input === "string") {
    input = [{ role: "user", content: text(value.input) }];
  } else {
    if (!Array.isArray(value.input) || value.input.length === 0 || value.input.length > MAX_MESSAGES) {
      throw new RequestValidationError("Input must contain 1 to 100 messages");
    }
    input = [];
    for (const item of value.input as unknown[]) {
      if (!object(item) || (item.type !== undefined && item.type !== "message")) {
        throw new RequestValidationError("Only message input items are supported");
      }
      if (typeof item.role !== "string" || !["user", "assistant", "system", "developer"].includes(item.role)) {
        throw new RequestValidationError("Unsupported message role");
      }
      const normalized = content(item.content);
      // Do not allow an agent-supplied prompt to override our consultant rules.
      if (item.role === "user" || item.role === "assistant") {
        input.push({ role: item.role, content: normalized });
      }
    }
  }
  if (!input.some((item) => item.role === "user" && item.content.trim())) {
    throw new RequestValidationError("Input must include a non-empty user message");
  }

  const maxOutputTokens = value.max_output_tokens ?? MAX_OUTPUT_TOKENS;
  if (typeof maxOutputTokens !== "number" || !Number.isInteger(maxOutputTokens) ||
      maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS) {
    throw new RequestValidationError("max_output_tokens must be an integer from 1 to 4096");
  }
  return { input, maxOutputTokens };
}

export async function readResponsesRequest(request: Request): Promise<ElevenLabsResponsesRequest> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RequestValidationError("Content-Type must be application/json", 415);
  }
  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) {
    throw new RequestValidationError("Request body exceeds 256 KiB", 413);
  }
  if (!request.body) throw new RequestValidationError("Request body is required");

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        throw new RequestValidationError("Request body exceeds 256 KiB", 413);
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof RequestValidationError) throw error;
    throw new RequestValidationError("Invalid request body");
  } finally {
    reader.releaseLock();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RequestValidationError("Invalid JSON body");
  }
  return validateResponsesRequest(parsed);
}
