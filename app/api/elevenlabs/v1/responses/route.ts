import { createHash, timingSafeEqual } from "node:crypto";
import { streamReply } from "@/lib/server/consultant/service";
import { readResponsesRequest, RequestValidationError } from "@/lib/server/elevenlabs/responses";
import { createResponsesSSE } from "@/lib/server/elevenlabs/sse";

export const runtime = "nodejs";

function errorResponse(message: string, status: number) {
  return Response.json({ error: { message } }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  const secret = process.env.ELEVENLABS_CUSTOM_LLM_SECRET;
  if (!secret) return errorResponse("Service is not configured", 503);

  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match || !timingSafeEqual(
    createHash("sha256").update(match[1]).digest(),
    createHash("sha256").update(secret).digest()
  )) {
    return errorResponse("Unauthorized", 401);
  }

  if (!process.env.OPENAI_VECTOR_STORE_ID?.trim()) {
    return errorResponse("Service is not configured", 503);
  }

  try {
    const input = await readResponsesRequest(request);
    const stream = await streamReply({ ...input, signal: request.signal });
    return new Response(createResponsesSSE(stream, request.signal), {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      console.warn({ message: error.message, status: error.status });
      return errorResponse(error.message, error.status);
    }
    return errorResponse("Unable to generate a response", 502);
  }
}
