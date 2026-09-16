import "server-only";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

type ResponseEventStream = AsyncIterable<ResponseStreamEvent> & {
  controller: AbortController;
};

const SAFE_ERROR = "Unable to generate a response";

// Diagnostics use fixed vocabulary, never provider text or arbitrary string fields.
const SAFE_ERROR_CODES = new Set([
  "server_error", "rate_limit_exceeded", "invalid_prompt", "data_residency_mismatch",
  "bio_policy", "vector_store_timeout", "invalid_image", "invalid_image_format",
  "invalid_base64_image", "invalid_image_url", "image_too_large", "image_too_small",
  "image_parse_error", "image_content_policy_violation", "invalid_image_mode",
  "image_file_too_large", "unsupported_image_media_type", "empty_image_file",
  "failed_to_download_image", "image_file_not_found", "invalid_api_key",
  "insufficient_quota", "model_not_found", "invalid_request_error",
  "context_length_exceeded", "invalid_value", "unsupported_value",
]);
const SAFE_ERROR_NAMES = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError",
  "OpenAIError", "APIError", "APIUserAbortError", "APIConnectionError",
  "APIConnectionTimeoutError", "BadRequestError", "AuthenticationError",
  "PermissionDeniedError", "NotFoundError", "ConflictError", "UnprocessableEntityError",
  "RateLimitError", "InternalServerError",
]);

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 64 && SAFE_ERROR_CODES.has(value)
    ? value
    : undefined;
}

function warnStreamEvent(event: ResponseStreamEvent) {
  if (event.type !== "error" && event.type !== "response.failed" && event.type !== "response.incomplete") return;
  const code = safeCode(event.type === "error" ? event.code : event.response.error?.code);
  console.warn({
    stage: "sse",
    eventType: event.type,
    ...(code === undefined ? {} : { code }),
    ...(Number.isSafeInteger(event.sequence_number) && event.sequence_number >= 0
      ? { sequence_number: event.sequence_number } : {}),
  });
}

function warnIteratorError(error: unknown) {
  const details = typeof error === "object" && error !== null
    ? error as { name?: unknown; code?: unknown; status?: unknown }
    : undefined;
  const className = details?.constructor?.name;
  const name = className && SAFE_ERROR_NAMES.has(className) ? className : details?.name;
  const code = safeCode(details?.code);
  console.warn({
    stage: "sse_iterator",
    name: typeof name === "string" && SAFE_ERROR_NAMES.has(name) ? name : "UnknownError",
    ...(typeof details?.status === "number" && Number.isFinite(details.status)
      ? { status: details.status } : {}),
    ...(code === undefined ? {} : { code }),
  });
}

function errorEvent(sequence: number): ResponseStreamEvent {
  return {
    type: "error",
    code: "server_error",
    message: SAFE_ERROR,
    param: null,
    sequence_number: sequence,
  };
}

function sanitizeEvent(event: ResponseStreamEvent): ResponseStreamEvent {
  if (event.type === "error") return errorEvent(event.sequence_number);
  if ("response" in event && event.response.error) {
    return {
      ...event,
      response: {
        ...event.response,
        error: { code: "server_error", message: SAFE_ERROR },
      },
    };
  }
  return event;
}

export function createResponsesSSE(source: ResponseEventStream, signal: AbortSignal) {
  const iterator = source[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let finished = false;
  let lastSequence = -1;
  let downstream: ReadableStreamDefaultController<Uint8Array>;

  function cleanup() {
    finished = true;
    signal.removeEventListener("abort", abort);
    source.controller.abort();
    void iterator.return?.().catch(() => undefined);
  }

  function abort() {
    if (finished) return;
    cleanup();
    downstream.close();
  }

  function encode(event: ResponseStreamEvent) {
    return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      downstream = controller;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      if (finished) return;
      try {
        let next: IteratorResult<ResponseStreamEvent>;
        try {
          next = await iterator.next();
        } catch (error) {
          if (!finished) warnIteratorError(error);
          throw error;
        }
        if (finished) return;
        if (next.done) {
          console.warn({ stage: "sse", eventType: "unexpected_eof" });
          // An upstream EOF without a terminal event is not a successful response.
          controller.enqueue(encode(errorEvent(lastSequence + 1)));
          cleanup();
          controller.close();
          return;
        }
        warnStreamEvent(next.value);
        const event = sanitizeEvent(next.value);
        lastSequence = event.sequence_number;
        controller.enqueue(encode(event));
        if (["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type)) {
          cleanup();
          controller.close();
        }
      } catch {
        if (finished) return;
        controller.enqueue(encode(errorEvent(lastSequence + 1)));
        cleanup();
        controller.close();
      }
    },
    cancel() {
      if (!finished) cleanup();
    },
  }, { highWaterMark: 0 });
}
