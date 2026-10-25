import { createHash } from "node:crypto";
import { parseStrictJSON, asRecord } from "./json";

export type ModelMessage = { readonly role: "system" | "user"; readonly content: string };
export type ModelJSONResponse = { readonly value: unknown; readonly bytes: string; readonly sha256: string };

const REQUEST_DEADLINE_MS = 120_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const COMPLETIONS_PATH = "/chat/completions";
const CONFIG_NAMES = ["MAINTENANCE_API_KEY", "MAINTENANCE_BASE_URL", "MAINTENANCE_MODEL"] as const;

export type ModelConfigName = (typeof CONFIG_NAMES)[number];
export type ModelRequestCode =
  | "model-config-missing"
  | "model-base-url-invalid"
  | "model-base-url-insecure"
  | "model-messages-invalid"
  | "model-timeout"
  | "model-request-failed"
  | "model-redirect-refused"
  | "model-http"
  | "model-response-empty"
  | "model-response-too-large"
  | "model-response-invalid-utf8"
  | "model-response-invalid-json"
  | "model-response-choice-invalid"
  | "model-response-not-content"
  | "model-response-content-invalid"
  | "model-content-invalid-json";

/**
 * Typed refusal from the model client: `code` is a fixed union and the only
 * dynamic parts are a known config variable name or a 100-599 HTTP status.
 * No provider text ever reaches `message`.
 */
export class ModelRequestError extends Error {
  readonly code: ModelRequestCode;
  readonly config?: ModelConfigName;
  readonly status?: number;
  constructor(code: ModelRequestCode, detail?: { readonly config: ModelConfigName } | { readonly status: number }) {
    const config = detail && "config" in detail ? detail.config : undefined;
    const status = detail && "status" in detail ? detail.status : undefined;
    super(status === undefined ? (config === undefined ? code : `${code}:${config}`) : `${code}-${status}`);
    this.name = "ModelRequestError";
    this.code = code;
    if (config !== undefined) {
      if (!CONFIG_NAMES.includes(config)) throw new RangeError("model-config-name-invalid");
      this.config = config;
    }
    if (status !== undefined) {
      if (!Number.isInteger(status) || status < 100 || status > 599) throw new RangeError("model-http-status-invalid");
      this.status = status;
    }
  }
}

function configuration(name: ModelConfigName): string {
  const value = process.env[name];
  if (!value) throw new ModelRequestError("model-config-missing", { config: name });
  return value;
}

function endpoint(base: string): string {
  let url: URL;
  try { url = new URL(base); } catch { throw new ModelRequestError("model-base-url-invalid"); }
  if (url.username || url.password || base.includes("?") || base.includes("#")) throw new ModelRequestError("model-base-url-invalid");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new ModelRequestError("model-base-url-insecure");
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith(COMPLETIONS_PATH)) url.pathname = path;
  else url.pathname = `${path}${COMPLETIONS_PATH}`;
  return url.toString();
}

async function boundedText(response: Response): Promise<string> {
  if (!response.body) throw new ModelRequestError("model-response-empty");
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
        throw new ModelRequestError("model-response-too-large");
      }
      chunks.push(chunk);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ModelRequestError("model-response-invalid-utf8"); }
}

function contentFromResponse(text: string): string {
  let parsed: unknown;
  try { parsed = parseStrictJSON(text); } catch { throw new ModelRequestError("model-response-invalid-json"); }
  const root = asRecord(parsed);
  const choices = root?.choices;
  if (!root || !Array.isArray(choices) || choices.length !== 1) throw new ModelRequestError("model-response-choice-invalid");
  const message = asRecord(asRecord(choices[0])?.message);
  const toolCalls = message?.tool_calls;
  const functionCall = message?.function_call;
  const refused = typeof message?.refusal === "string" && message.refusal.trim() !== "";
  if (!message || refused || (Array.isArray(toolCalls) && toolCalls.length > 0) || (functionCall !== undefined && functionCall !== null)) {
    throw new ModelRequestError("model-response-not-content");
  }
  if (typeof message.content !== "string" || message.content.length === 0) throw new ModelRequestError("model-response-content-invalid");
  return message.content;
}

export async function requestModelJSON(messages: readonly ModelMessage[]): Promise<ModelJSONResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestModelJSONOnce(messages);
    } catch (error) {
      if (!(error instanceof ModelRequestError) || attempt >= 2 || !retryableModelFailure(error)) throw error;
      await Bun.sleep(attempt === 0 ? 1_000 : 2_000);
    }
  }
}

function retryableModelFailure(error: ModelRequestError): boolean {
  if (error.code === "model-timeout" || error.code === "model-request-failed") return true;
  return error.code === "model-http" && (error.status === 404 || error.status === 429 || (error.status ?? 0) >= 500);
}

async function requestModelJSONOnce(messages: readonly ModelMessage[]): Promise<ModelJSONResponse> {
  const apiKey = configuration("MAINTENANCE_API_KEY");
  const model = configuration("MAINTENANCE_MODEL");
  const url = endpoint(configuration("MAINTENANCE_BASE_URL"));
  if (!Array.isArray(messages) || messages.length === 0 || messages.some(message =>
    !message || (message.role !== "system" && message.role !== "user") || typeof message.content !== "string")) {
    throw new ModelRequestError("model-messages-invalid");
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
      if (controller.signal.aborted) throw new ModelRequestError("model-timeout");
      throw new ModelRequestError("model-request-failed");
    }
    if (response.status >= 300 && response.status < 400) throw new ModelRequestError("model-redirect-refused");
    const status = response.status;
    if (!response.ok) throw new ModelRequestError("model-http", Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : undefined);
    const outer = await boundedText(response);
    const content = contentFromResponse(outer);
    let value: unknown;
    try { value = parseStrictJSON(content); } catch { throw new ModelRequestError("model-content-invalid-json"); }
    return { value, bytes: content, sha256: createHash("sha256").update(new TextEncoder().encode(content)).digest("hex") };
  } finally { clearTimeout(timeout); }
}
