import "server-only";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

type ResponseEventStream = AsyncIterable<ResponseStreamEvent> & {
  controller: AbortController;
};

const SAFE_ERROR = "Unable to generate a response";

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
        const next = await iterator.next();
        if (finished) return;
        if (next.done) {
          // An upstream EOF without a terminal event is not a successful response.
          controller.enqueue(encode(errorEvent(lastSequence + 1)));
          cleanup();
          controller.close();
          return;
        }
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
