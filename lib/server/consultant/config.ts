import "server-only";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";

export function getConsultantConfig() {
  const apiKey = process.env.OPENAI_API_KEY;
  const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const tools: ResponseCreateParamsNonStreaming["tools"] = vectorStoreId
    ? [{ type: "file_search", vector_store_ids: [vectorStoreId] }]
    : [];

  return { apiKey, model: "gpt-5.6", tools };
}
