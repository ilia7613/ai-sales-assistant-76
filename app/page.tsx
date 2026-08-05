"use client";

import { FormEvent, useState } from "react";

export default function Home() {
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState("");
  const [loading, setLoading] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState("");

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!message.trim() || loading) return;

    setLoading(true);
    setReply("");
    setError("");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Не удалось получить ответ");
      }

      setReply(data.reply);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Произошла ошибка");
    } finally {
      setLoading(false);
    }
  }

  async function speakReply() {
    if (!reply || speaking) return;

    setSpeaking(true);
    setError("");

    try {
      const response = await fetch("/api/speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: reply }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Не удалось озвучить ответ");
      }

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);

      audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        setSpeaking(false);
      };

      audio.onerror = () => {
        URL.revokeObjectURL(audioUrl);
        setSpeaking(false);
        setError("Не удалось воспроизвести звук");
      };

      await audio.play();
    } catch (err) {
      setSpeaking(false);
      setError(err instanceof Error ? err.message : "Произошла ошибка");
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-12 text-white">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8">
          <p className="mb-2 text-sm font-semibold uppercase tracking-widest text-cyan-400">
            Рабочий прототип
          </p>

          <h1 className="text-4xl font-bold">
            ИИ-продавец ветеринарного оборудования
          </h1>

          <p className="mt-4 text-slate-300">
            Напишите вопрос клиента. ИИ подготовит ответ, а ElevenLabs
            озвучит его вашим голосом.
          </p>
        </div>

        <form
          onSubmit={sendMessage}
          className="rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-xl"
        >
          <label
            htmlFor="message"
            className="mb-3 block text-sm font-semibold text-slate-200"
          >
            Сообщение клиента
          </label>

          <textarea
            id="message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Например: Мне нужен компьютерный томограф для ветеринарной клиники"
            className="min-h-36 w-full resize-y rounded-xl border border-slate-600 bg-slate-950 p-4 text-white outline-none focus:border-cyan-400"
          />

          <button
            type="submit"
            disabled={loading || !message.trim()}
            className="mt-4 w-full rounded-xl bg-cyan-500 px-5 py-3 font-bold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "ИИ готовит ответ..." : "Получить ответ"}
          </button>
        </form>

        {reply && (
          <section className="mt-6 rounded-2xl border border-slate-700 bg-slate-900 p-6">
            <h2 className="mb-3 text-lg font-bold text-cyan-400">
              Ответ ИИ-продавца
            </h2>

            <p className="whitespace-pre-wrap leading-7 text-slate-100">
              {reply}
            </p>

            <button
              type="button"
              onClick={speakReply}
              disabled={speaking}
              className="mt-5 rounded-xl border border-cyan-400 px-5 py-3 font-semibold text-cyan-300 transition hover:bg-cyan-400 hover:text-slate-950 disabled:opacity-50"
            >
              {speaking ? "Говорит..." : "Озвучить моим голосом"}
            </button>
          </section>
        )}

        {error && (
          <div className="mt-6 rounded-xl border border-red-500 bg-red-950 p-4 text-red-200">
            {error}
          </div>
        )}
      </div>
    </main>
  );
}