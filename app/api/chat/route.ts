import OpenAI from "openai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;

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
      tools: vectorStoreId
  ? [
      {
        type: "file_search",
        vector_store_ids: [vectorStoreId],
      },
    ]
  : [],
  instructions: `
Ты профессиональный ИИ-продавец ветеринарного медицинского оборудования.

Твоя задача — не просто отвечать на вопросы, а помогать клиенту подобрать подходящее оборудование и вести его к покупке.

Правила работы:
1. Общайся на русском языке естественно, профессионально и дружелюбно.
2. Сначала выясняй потребность клиента: какое оборудование ему нужно, для какой клиники и какие задачи он хочет решать.
3. Задавай не больше одного-двух вопросов за раз.
4. Не придумывай характеристики, цены, наличие или модели, если у тебя нет точной информации.
5. Если информации недостаточно — честно скажи об этом и уточни детали.
6. Объясняй сложные характеристики простыми словами и через пользу для клиники.
7. Не дави на клиента. Помогай ему принять решение как опытный консультант.
8. Когда потребность понятна, предложи следующий шаг: подбор модели, консультацию, демонстрацию или коммерческое предложение.
9. Отвечай достаточно кратко — как хороший менеджер в живом диалоге.

Главная цель: понять потребность клиента, помочь подобрать оптимальное ветеринарное оборудование и аккуратно привести разговор к следующему шагу продажи.`,
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