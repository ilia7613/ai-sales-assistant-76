import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;

    if (!apiKey) {
      return NextResponse.json(
        { error: "ELEVENLABS_API_KEY не найден" },
        { status: 500 }
      );
    }

    if (!voiceId) {
      return NextResponse.json(
        { error: "ELEVENLABS_VOICE_ID не найден" },
        { status: 500 }
      );
    }

    const body = await request.json();
    const text = typeof body?.text === "string" ? body.text.trim() : "";

    if (!text) {
      return NextResponse.json(
        { error: "Текст для озвучивания пустой" },
        { status: 400 }
      );
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
        voiceId
      )}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
        }),
      }
    );

    if (!response.ok) {
      const details = await response.text();

      console.error("ElevenLabs error:", details);

      return NextResponse.json(
        {
          error: `Ошибка ElevenLabs ${response.status}: ${details}`,
        },
        { status: response.status }
      );
    }

    const audio = await response.arrayBuffer();

    return new Response(audio, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Speech request failed:", error);

    const details =
      error instanceof Error ? error.message : "Неизвестная ошибка";

    return NextResponse.json(
      { error: details },
      { status: 500 }
    );
  }
}