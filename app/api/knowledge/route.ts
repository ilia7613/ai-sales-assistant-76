import { NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;

    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY не найден" },
        { status: 500 }
      );
    }

    if (!vectorStoreId) {
      return NextResponse.json(
        { error: "OPENAI_VECTOR_STORE_ID не найден" },
        { status: 500 }
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Файл не передан" },
        { status: 400 }
      );
    }

    const openai = new OpenAI({ apiKey });

    const uploadedFile = await openai.files.create({
      file,
      purpose: "user_data",
    });

    await openai.vectorStores.files.create(vectorStoreId, {
      file_id: uploadedFile.id,
    });

    return NextResponse.json({
      ok: true,
      fileName: file.name,
      fileId: uploadedFile.id,
    });
  } catch (error) {
    console.error("Knowledge upload error:", error);

    const details =
      error instanceof Error ? error.message : "Неизвестная ошибка";

    return NextResponse.json(
      { error: details },
      { status: 500 }
    );
  }
}