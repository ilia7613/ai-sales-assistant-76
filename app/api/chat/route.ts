import OpenAI from "openai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is missing" },
        { status: 500 }
      );
    }

    const body = await request.json();
    const message =
      typeof body?.message === "string" ? body.message.trim() : "";

    if (!message) {
      return NextResponse.json(
        { error: "Message is empty" },
        { status: 400 }
      );
    }

    const client = new OpenAI({ apiKey });

    const response = await client.responses.create({
      model: "gpt-5.6",
      instructions:
        "You are a professional sales consultant for veterinary medical equipment. First clarify the clinic's needs. Do not invent prices, models, or specifications. Guide the customer toward a consultation, demonstration, or commercial proposal. Answer naturally and briefly in Russian.",
      input: message,
    });

    const reply = response.output_text?.trim();

    if (!reply) {
      return NextResponse.json(
        { error: "OpenAI returned an empty response" },
        { status: 500 }
      );
    }

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