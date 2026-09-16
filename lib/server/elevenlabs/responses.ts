import "server-only";
import type { ResponseReasoningItem } from "openai/resources/responses/responses";
import { CONSULTANT_MODEL } from "../consultant/config";
import type { ConversationMessage } from "../consultant/service";

export const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_MESSAGES = 100;
const MAX_TEXT_LENGTH = 10_000;
const MAX_OUTPUT_TOKENS = 4096;

// Diagnostic labels only; unsupported items remain rejected by the validator.
const SAFE_INPUT_ITEM_TYPES = new Set([
  "reasoning", "item_reference", "file_search_call", "web_search_call",
  "function_call", "function_call_output", "computer_call", "computer_call_output",
  "tool_search_call", "tool_search_output", "additional_tools", "compaction",
  "image_generation_call", "code_interpreter_call", "local_shell_call", "local_shell_call_output",
  "shell_call", "shell_call_output", "apply_patch_call", "apply_patch_call_output",
  "mcp_list_tools", "mcp_approval_request", "mcp_approval_response", "mcp_call",
  "custom_tool_call", "custom_tool_call_output", "compaction_trigger", "program", "program_output",
]);

export class RequestValidationError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

export type ElevenLabsResponsesRequest = {
  input: (ConversationMessage | ResponseReasoningItem)[];
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

function reasoningItem(item: Record<string, unknown>): ResponseReasoningItem {
  const allowed = new Set<keyof ResponseReasoningItem>([
    "type", "id", "summary", "content", "encrypted_content", "status",
  ]);
  const invalid = () => new RequestValidationError("Invalid reasoning item");
  if (Object.keys(item).some((key) => !allowed.has(key as keyof ResponseReasoningItem)) ||
      item.type !== "reasoning" || typeof item.id !== "string" || item.id.length > MAX_TEXT_LENGTH) {
    throw invalid();
  }
  function parts<T extends "summary_text" | "reasoning_text">(
    value: unknown, type: T
  ): { type: T; text: string }[] {
    if (!Array.isArray(value) || value.length > 100) throw invalid();
    return value.map((part: unknown) => {
      if (!object(part) || Object.keys(part).some((key) => key !== "type" && key !== "text") ||
          part.type !== type || typeof part.text !== "string" || part.text.length > MAX_TEXT_LENGTH) {
        throw invalid();
      }
      return { type, text: part.text };
    });
  }
  const result: ResponseReasoningItem = {
    type: "reasoning", id: item.id, summary: parts(item.summary, "summary_text"),
  };
  if (item.content !== undefined) result.content = parts(item.content, "reasoning_text");
  if (item.encrypted_content !== undefined) {
    // Opaque ciphertext can exceed the message text limit; the body remains capped at 256 KiB.
    if (item.encrypted_content !== null &&
        (typeof item.encrypted_content !== "string" || item.encrypted_content.length > MAX_REQUEST_BYTES)) {
      throw invalid();
    }
    result.encrypted_content = item.encrypted_content;
  }
  if (item.status !== undefined) {
    if (item.status !== "in_progress" && item.status !== "completed" && item.status !== "incomplete") {
      throw invalid();
    }
    result.status = item.status;
  }
  return result;
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

  let input: ElevenLabsResponsesRequest["input"];
  if (typeof value.input === "string") {
    input = [{ role: "user", content: text(value.input) }];
  } else {
    if (!Array.isArray(value.input) || value.input.length === 0 || value.input.length > MAX_MESSAGES) {
      throw new RequestValidationError("Input must contain 1 to 100 messages");
    }
    input = [];
    for (const item of value.input as unknown[]) {
      if (object(item) && item.type === "reasoning") {
        input.push(reasoningItem(item));
        continue;
      }
      if (!object(item) || (item.type !== undefined && item.type !== "message")) {
        const safeType = object(item) && typeof item.type === "string" && SAFE_INPUT_ITEM_TYPES.has(item.type)
          ? item.type
          : "unknown";
        throw new RequestValidationError(`Unsupported input item type: ${safeType}`);
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
  if (!input.some((item) => "role" in item && item.role === "user" && item.content.trim())) {
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
