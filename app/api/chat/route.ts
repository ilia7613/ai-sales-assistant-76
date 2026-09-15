import { NextResponse } from "next/server";
import {
  generateReply,
  type ConversationMessage,
} from "@/lib/server/consultant/service";

export const runtime = "nodejs";

const MAX_HISTORY_MESSAGES = 100;
const MAX_MESSAGE_LENGTH = 10_000;

function isConversationMessage(value: unknown): value is ConversationMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const entry = value as Record<string, unknown>;
  return (
    (entry.role === "user" || entry.role === "assistant") &&
    typeof entry.content === "string" &&
    entry.content.length <= MAX_MESSAGE_LENGTH
  );
}

export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json(
        { error: "Body must be an object" },
        { status: 400 }
      );
    }

    const payload = body as Record<string, unknown>;
    const rawMessage =
      typeof payload.message === "string" ? payload.message : "";
    const message = rawMessage.trim();

    if (!message) {
      return NextResponse.json(
        { error: "Message is empty" },
        { status: 400 }
      );
    }

    if (rawMessage.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json(
        { error: `Message must not exceed ${MAX_MESSAGE_LENGTH} characters` },
        { status: 400 }
      );
    }

    const history = payload.history === undefined ? [] : payload.history;
    if (
      !Array.isArray(history) ||
      history.length > MAX_HISTORY_MESSAGES ||
      !history.every(isConversationMessage)
    ) {
      return NextResponse.json(
        {
          error: `History must contain at most ${MAX_HISTORY_MESSAGES} user/assistant messages with string content up to ${MAX_MESSAGE_LENGTH} characters`,
        },
        { status: 400 }
      );
    }

    const reply = await generateReply({
      message,
      history: history.map(({ role, content }) => ({ role, content })),
    });

    return NextResponse.json({ reply });
  } catch (error) {
    console.error("OpenAI request failed:", error);

    const details =
      error instanceof Error ? error.message : "Unknown OpenAI error";

    return NextResponse.json(
      { error: details },
      { status: 500 }
    );
  }
}
