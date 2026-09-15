import "server-only";
import OpenAI from "openai";
import { getConsultantConfig } from "./config";
import { consultantInstructions } from "./prompt";

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

type GenerateReplyInput = {
  message: string;
  history: ConversationMessage[];
};

export type StreamReplyInput = {
  input: ConversationMessage[];
  maxOutputTokens: number;
  signal?: AbortSignal;
};

export async function streamReply({
  input,
  maxOutputTokens,
  signal,
}: StreamReplyInput) {
  const { apiKey, model, tools } = getConsultantConfig();
  const client = new OpenAI({ apiKey });

  return client.responses.create(
    {
      model,
      tools,
      instructions: consultantInstructions,
      input,
      stream: true,
      store: false,
      max_output_tokens: maxOutputTokens,
    },
    { signal, maxRetries: 0, timeout: 60_000 }
  );
}

export async function generateReply({ message, history }: GenerateReplyInput) {
  const { apiKey, model, tools } = getConsultantConfig();
  const client = new OpenAI({ apiKey });

  const response = await client.responses.create({
    model,
    tools,
    instructions: consultantInstructions,
    input: [...history, { role: "user", content: message }],
  });

  const reply = response.output_text?.trim();

  if (!reply) {
    throw new Error("OpenAI returned an empty response");
  }

  return reply;
}
