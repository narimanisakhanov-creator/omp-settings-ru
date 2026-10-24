import { createHash } from "node:crypto";
import { parseStrictJSON, asRecord } from "./json";

export type ModelMessage = { readonly role: "system" | "user"; readonly content: string };
export type ModelJSONResponse = { readonly value: unknown; readonly bytes: string; readonly sha256: string };

const REQUEST_DEADLINE_MS = 120_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const COMPLETIONS_PATH = "/chat/completions";

function configuration(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`model-config-missing:${name}`);
  return value;
}

function endpoint(base: string): string {
  let url: URL;
  try { url = new URL(base); } catch { throw new Error("model-base-url-invalid"); }
  if (url.username || url.password || base.includes("?") || base.includes("#")) throw new Error("model-base-url-invalid");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("model-base-url-insecure");
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith(COMPLETIONS_PATH)) url.pathname = path;
  else url.pathname = `${path}${COMPLETIONS_PATH}`;
  return url.toString();
}

async function boundedText(response: Response): Promise<string> {
  if (!response.body) throw new Error("model-response-empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      size += chunk.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("model-response-too-large");
      }
      chunks.push(chunk);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function contentFromResponse(text: string): string {
  let parsed: unknown;
  try { parsed = parseStrictJSON(text); } catch { throw new Error("model-response-invalid-json"); }
  const root = asRecord(parsed);
  const choices = root?.choices;
  if (!root || !Array.isArray(choices) || choices.length !== 1) throw new Error("model-response-choice-invalid");
  const message = asRecord(asRecord(choices[0])?.message);
  if (!message || (message.refusal !== undefined && message.refusal !== null) || Object.hasOwn(message, "tool_calls") || Object.hasOwn(message, "function_call")) {
    throw new Error("model-response-not-content");
  }
  if (typeof message.content !== "string" || message.content.length === 0) throw new Error("model-response-content-invalid");
  return message.content;
}

export async function requestModelJSON(messages: readonly ModelMessage[]): Promise<ModelJSONResponse> {
  const apiKey = configuration("MAINTENANCE_API_KEY");
  const model = configuration("MAINTENANCE_MODEL");
  const url = endpoint(configuration("MAINTENANCE_BASE_URL"));
  if (!Array.isArray(messages) || messages.length === 0 || messages.some(message =>
    !message || (message.role !== "system" && message.role !== "user") || typeof message.content !== "string")) {
    throw new Error("model-messages-invalid");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_DEADLINE_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages, stream: false }),
      });
    } catch {
      if (controller.signal.aborted) throw new Error("model-timeout");
      throw new Error("model-request-failed");
    }
    if (response.status >= 300 && response.status < 400) throw new Error("model-redirect-refused");
    if (!response.ok) throw new Error(`model-http-${response.status}`);
    const outer = await boundedText(response);
    const content = contentFromResponse(outer);
    let value: unknown;
    try { value = parseStrictJSON(content); } catch { throw new Error("model-content-invalid-json"); }
    return { value, bytes: content, sha256: createHash("sha256").update(new TextEncoder().encode(content)).digest("hex") };
  } finally { clearTimeout(timeout); }
}
