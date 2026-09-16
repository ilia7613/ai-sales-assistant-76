import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);

// Compile the real TypeScript in memory. Never load Next's env loader or real API clients.
export function createHarness({ create, secret = "test-only-secret" } = {}) {
  const calls = [];
  const warnings = [];
  const env = {
    ELEVENLABS_CUSTOM_LLM_SECRET: secret,
    OPENAI_API_KEY: "test-only-key",
    OPENAI_VECTOR_STORE_ID: "test-only-store",
  };
  class MockOpenAI {
    responses = {
      create: async (params, options) => {
        calls.push({ params, options });
        return create ? create(params, options) : { output_text: " Web reply " };
      },
    };
  }
  const cache = new Map();
  function load(relative) {
    const filename = path.resolve(root, relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const compiledModule = { exports: {} };
    cache.set(filename, compiledModule);
    const js = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    runInNewContext(js, {
      module: compiledModule, exports: compiledModule.exports,
      require(name) {
        if (name === "server-only") return {};
        if (name === "openai") return MockOpenAI;
        if (name === "node:crypto") return require(name);
        if (name.startsWith("@/")) return load(name.slice(2) + ".ts");
        if (name.startsWith(".")) return load(path.resolve(path.dirname(filename), name + ".ts"));
        throw new Error("Unexpected test import");
      },
      process: { env },
      console: { warn: (...args) => warnings.push(args) },
      Response, Request, Headers, ReadableStream, TextEncoder, TextDecoder, AbortController,
    }, { filename });
    return compiledModule.exports;
  }
  return { load, calls, env, warnings };
}
