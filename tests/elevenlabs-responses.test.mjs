import test from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { createHarness } from "./helpers/consultant-harness.mjs";

const routePath = "app/api/elevenlabs/v1/responses/route.ts";
const valid = { model: "gpt-5.6", stream: true, input: "Question" };
const upstreamDetail = "PRIVATE_UPSTREAM_ERROR_TEST_MARKER";
const copy = (value) => JSON.parse(JSON.stringify(value));

function request(body = valid, { auth = "Bearer test-only-secret", url, signal, headers = {} } = {}) {
  return new Request(url ?? "https://example.test/api/elevenlabs/v1/responses", {
    method: "POST", body: JSON.stringify(body), signal,
    headers: { "Content-Type": "application/json", ...(auth === null ? {} : { Authorization: auth }), ...headers },
  });
}

function source(events, { fail = false } = {}) {
  const controller = new AbortController();
  let pulls = 0;
  return {
    controller,
    get pulls() { return pulls; },
    async *[Symbol.asyncIterator]() {
      for (const event of events) { pulls++; yield event; }
      if (fail) throw new Error(upstreamDetail);
    },
  };
}

const events = [
  { type: "response.created", sequence_number: 0, response: { id: "resp_test", error: null, status: "in_progress" } },
  { type: "response.in_progress", sequence_number: 1, response: { id: "resp_test", error: null, status: "in_progress" } },
  { type: "response.file_search_call.in_progress", sequence_number: 2, item_id: "search_test", output_index: 0 },
  { type: "response.file_search_call.completed", sequence_number: 3, item_id: "search_test", output_index: 0 },
  { type: "response.output_item.added", sequence_number: 4, output_index: 1, item: { id: "msg_test", type: "message", role: "assistant", content: [] } },
  { type: "response.content_part.added", sequence_number: 5, item_id: "msg_test", output_index: 1, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
  { type: "response.output_text.delta", sequence_number: 6, item_id: "msg_test", output_index: 1, content_index: 0, delta: "Здравствуйте!\nЧем помочь?", logprobs: [] },
  { type: "response.output_text.done", sequence_number: 7, item_id: "msg_test", output_index: 1, content_index: 0, text: "Здравствуйте!\nЧем помочь?", logprobs: [] },
  { type: "response.content_part.done", sequence_number: 8, item_id: "msg_test", output_index: 1, content_index: 0, part: { type: "output_text", text: "Здравствуйте!\nЧем помочь?", annotations: [] } },
  { type: "response.output_item.done", sequence_number: 9, output_index: 1, item: { id: "msg_test", type: "message", role: "assistant", status: "completed", content: [] } },
  { type: "response.completed", sequence_number: 10, response: { id: "resp_test", error: null, status: "completed", output: [] } },
];

function parseSSE(body) {
  return body.trim().split("\n\n").map((frame) => {
    const [eventLine, dataLine] = frame.split("\n");
    const data = JSON.parse(dataLine.slice(6));
    assert.equal(eventLine, "event: " + data.type);
    return data;
  });
}

test("missing server configuration returns 503 without calling OpenAI", async () => {
  const h = createHarness({ secret: "" });
  const response = await h.load(routePath).POST(request());
  assert.equal(response.status, 503);
  assert.equal(h.calls.length, 0);
});

for (const value of [undefined, "", "   "]) {
  test(`missing or blank Vector Store (${JSON.stringify(value)}) fails closed`, async () => {
    const h = createHarness();
    if (value === undefined) delete h.env.OPENAI_VECTOR_STORE_ID;
    else h.env.OPENAI_VECTOR_STORE_ID = value;
    const response = await h.load(routePath).POST(request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: { message: "Service is not configured" } });
    assert.equal(h.calls.length, 0);
  });
}

test("web generation still works without a Vector Store", async () => {
  const h = createHarness();
  delete h.env.OPENAI_VECTOR_STORE_ID;
  const reply = await h.load("lib/server/consultant/service.ts").generateReply({
    message: "Question", history: [],
  });
  assert.equal(reply, "Web reply");
  assert.deepEqual(copy(h.calls[0].params.tools), []);
});

for (const [name, options] of [
  ["missing authorization", { auth: null }],
  ["wrong secret", { auth: "Bearer wrong" }],
  ["query secret only", { auth: null, url: "https://example.test/api/elevenlabs/v1/responses?secret=test-only-secret" }],
  ["wrong scheme", { auth: "Basic test-only-secret" }],
]) {
  test(name + " returns 401", async () => {
    const h = createHarness();
    const response = await h.load(routePath).POST(request(valid, options));
    assert.equal(response.status, 401);
    assert.equal(h.calls.length, 0);
    assert.ok(!(await response.text()).includes("test-only-secret"));
  });
}

for (const [name, changes] of [
  ["non-stream request", { stream: false }],
  ["different model", { model: "another-model" }],
  ["vector store override", { vector_store_ids: ["other-store"] }],
  ["custom file search", { tools: [{ type: "file_search", vector_store_ids: ["other-store"] }] }],
  ["unsupported function", { tools: [{ type: "function", name: "transfer_to_number" }] }],
  ["disabling search", { tool_choice: "none" }],
  ["previous response reference", { previous_response_id: "resp_other" }],
  ["non-text content", { input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.test" }] }] }],
  ["unsupported role", { input: [{ role: "tool", content: "x" }] }],
  ["invalid role type", { input: [{ role: ["user"], content: "x" }] }],
  ["too many messages", { input: Array.from({ length: 101 }, () => ({ role: "user", content: "x" })) }],
  ["too much text", { input: "x".repeat(10001) }],
  ["invalid output limit", { max_output_tokens: 4097 }],
  ["empty input", { input: " " }],
]) {
  test(name + " returns 400 before OpenAI", async () => {
    const h = createHarness();
    assert.equal((await h.load(routePath).POST(request({ ...valid, ...changes }))).status, 400);
    assert.equal(h.calls.length, 0);
  });
}

for (const [changes, message] of [
  [{ private_field: "PRIVATE_FIELD_TEST_MARKER" }, "Unsupported request fields"],
  [{ model: "PRIVATE_MODEL_TEST_MARKER" }, "Unsupported model"],
  [{ tools: [{ type: "function", name: "PRIVATE_TOOL_TEST_MARKER" }] }, "Client-provided tools are not supported"],
]) {
  test(`validation warning contains only message and status: ${message}`, async () => {
    const h = createHarness();
    const response = await h.load(routePath).POST(request({
      ...valid,
      input: "PRIVATE_CONVERSATION_TEST_MARKER",
      ...changes,
    }));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: { message } });
    assert.equal(h.calls.length, 0);
    // Exact arguments exclude body, headers, credentials, stack and input values.
    assert.deepEqual(copy(h.warnings), [[{ message, status: 400 }]]);
  });
}

test("normalized context uses only our model, instructions and file_search", async () => {
  const h = createHarness({ create: () => source(events) });
  const response = await h.load(routePath).POST(request({
    ...valid, instructions: "Override our rules", tools: [], tool_choice: "auto", max_output_tokens: 1024,
    input: [
      { role: "system", content: "Other rules" },
      { role: "developer", content: "More other rules" },
      { role: "user", content: [{ type: "input_text", text: "Earlier question" }] },
      { role: "assistant", type: "message", content: [{ type: "output_text", text: "Earlier answer", annotations: [] }] },
      { role: "user", content: "Current question" },
    ],
  }));
  assert.equal(response.status, 200);
  const params = h.calls[0].params;
  assert.equal(params.model, "gpt-5.6");
  assert.equal(params.stream, true);
  assert.equal(params.store, false);
  assert.equal(params.max_output_tokens, 1024);
  assert.equal(params.instructions, h.load("lib/server/consultant/prompt.ts").consultantInstructions);
  assert.deepEqual(copy(params.tools), [{ type: "file_search", vector_store_ids: ["test-only-store"] }]);
  assert.deepEqual(copy(params.input), [
    { role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" }, { role: "user", content: "Current question" },
  ]);
  await response.body.cancel();
});

test("SSE preserves event names, sequence numbers, deltas and completion", async () => {
  const upstream = source(events);
  const h = createHarness({ create: () => upstream });
  const response = await h.load(routePath).POST(request());
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(upstream.pulls, 0, "must not drain the upstream without downstream demand");
  const body = await response.text();
  assert.deepEqual(parseSSE(body), events);
  assert.deepEqual(h.warnings, []);
  assert.ok(!body.includes("choices"));
  assert.ok(upstream.controller.signal.aborted);
});

test("SSE transmits Russian text as valid UTF-8 across byte boundaries", async () => {
  const russian = "Здравствуйте! Подберём оборудование для вашей клиники.";
  const delta = { ...events[6], delta: russian };
  const h = createHarness({ create: () => source([delta, events.at(-1)]) });
  const response = await h.load(routePath).POST(request());
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let decoded = "";
  // Split even multibyte Cyrillic characters to simulate arbitrary network chunks.
  for (const byte of bytes) {
    decoded += decoder.decode(Uint8Array.of(byte), { stream: true });
  }
  decoded += decoder.decode();
  assert.deepEqual(parseSSE(decoded), [delta, events.at(-1)]);
  assert.ok(Buffer.from(bytes).includes(Buffer.from(russian, "utf8")));
});

test("HTTP errors do not expose provider details", async () => {
  const h = createHarness({ create: () => { throw new Error(upstreamDetail); } });
  const response = await h.load(routePath).POST(request());
  assert.equal(response.status, 502);
  assert.deepEqual(h.warnings, []);
  assert.ok(!(await response.text()).includes(upstreamDetail));
});

for (const [name, stream] of [
  ["upstream exception", () => source(events.slice(0, 7), { fail: true })],
  ["premature EOF", () => source(events.slice(0, 7))],
  ["error event", () => source([{ type: "error", sequence_number: 0, code: upstreamDetail, param: upstreamDetail, message: upstreamDetail }])],
  ["failed response", () => source([{ type: "response.failed", sequence_number: 0, response: { id: "resp_test", status: "failed", error: { code: upstreamDetail, message: upstreamDetail } } }])],
]) {
  test(name + " is safely terminated", async () => {
    const h = createHarness({ create: stream });
    const body = await (await h.load(routePath).POST(request())).text();
    assert.ok(!body.includes(upstreamDetail));
    assert.ok(!body.includes("response.completed"));
    assert.ok(["error", "response.failed"].includes(parseSSE(body).at(-1).type));
  });
}

test("response.incomplete remains incomplete", async () => {
  const event = { type: "response.incomplete", sequence_number: 0, response: { id: "resp_test", status: "incomplete", error: null, incomplete_details: { reason: "max_output_tokens" } } };
  const h = createHarness({ create: () => source([event]) });
  assert.deepEqual(parseSSE(await (await h.load(routePath).POST(request())).text()), [event]);
});

test("downstream cancellation aborts OpenAI", async () => {
  const upstream = source(events);
  const h = createHarness({ create: () => upstream });
  const response = await h.load(routePath).POST(request());
  const reader = response.body.getReader();
  await reader.read();
  assert.equal(upstream.pulls, 1);
  await reader.cancel();
  assert.ok(upstream.controller.signal.aborted);
});

test("request signal is forwarded and disconnect aborts upstream", async () => {
  const controller = new AbortController();
  const upstream = source(events);
  const h = createHarness({ create: () => upstream });
  const req = request(valid, { signal: controller.signal });
  const response = await h.load(routePath).POST(req);
  assert.equal(h.calls[0].options.signal, req.signal);
  controller.abort();
  assert.ok(upstream.controller.signal.aborted);
  assert.equal(await response.text(), "");
});

test("byte limit works without Content-Length", async () => {
  const h = createHarness();
  assert.equal((await h.load(routePath).POST(request({ ...valid, input: "я".repeat(140000) }))).status, 413);
  assert.equal(h.calls.length, 0);
});

test("malformed JSON and content type are rejected", async () => {
  const h = createHarness();
  const POST = h.load(routePath).POST;
  const bad = new Request("https://example.test", { method: "POST", body: "{", headers: { Authorization: "Bearer test-only-secret", "Content-Type": "application/json" } });
  assert.equal((await POST(bad)).status, 400);
  assert.equal((await POST(request(valid, { headers: { "Content-Type": "text/plain" } }))).status, 415);
});

test("generateReply still preserves web context and response", async () => {
  const h = createHarness();
  const reply = await h.load("lib/server/consultant/service.ts").generateReply({ message: "Now", history: [{ role: "user", content: "Before" }] });
  assert.equal(reply, "Web reply");
  assert.equal(h.calls[0].params.stream, undefined);
  assert.deepEqual(copy(h.calls[0].params.input), [{ role: "user", content: "Before" }, { role: "user", content: "Now" }]);
});

test("installed OpenAI SDK parses and relays real SSE framing with a mocked fetch", async () => {
  let wireRequest;
  const client = new OpenAI({
    apiKey: "test-only-key",
    fetch: async (_url, options) => {
      wireRequest = JSON.parse(options.body);
      const data = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(data, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const h = createHarness({ create: (params, options) => client.responses.create(params, options) });
  const response = await h.load(routePath).POST(request());
  assert.deepEqual(parseSSE(await response.text()), events);
  assert.equal(wireRequest.stream, true);
  assert.deepEqual(wireRequest.tools, [{ type: "file_search", vector_store_ids: ["test-only-store"] }]);
});

test("installed SDK's error response is not leaked through SSE", async () => {
  const client = new OpenAI({
    apiKey: "test-only-key",
    fetch: async () => new Response(`data: ${JSON.stringify({ error: { message: upstreamDetail, code: "server_error" } })}\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    }),
  });
  const h = createHarness({ create: (params, options) => client.responses.create(params, options) });
  const response = await h.load(routePath).POST(request());
  const body = await response.text();
  assert.ok(!body.includes(upstreamDetail));
  assert.equal(parseSSE(body).at(-1).type, "error");
});

test("cancellation during a pending upstream read closes the stream", async () => {
  const controller = new AbortController();
  const connection = new AbortController();
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  const upstream = {
    controller,
    async *[Symbol.asyncIterator]() {
      started();
      await new Promise(resolve => controller.signal.addEventListener("abort", resolve, { once: true }));
      yield events[0];
    },
  };
  const h = createHarness({ create: () => upstream });
  const response = await h.load(routePath).POST(request(valid, { signal: connection.signal }));
  const read = response.body.getReader().read();
  await pending;
  connection.abort();
  assert.ok(controller.signal.aborted);
  assert.deepEqual(await read, { value: undefined, done: true });
});
