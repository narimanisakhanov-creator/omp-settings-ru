import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { requestModelJSON } from "../scripts/maintenance/model";

const saved = { key: process.env.MAINTENANCE_API_KEY, base: process.env.MAINTENANCE_BASE_URL, model: process.env.MAINTENANCE_MODEL };
const restore = () => { for (const [key, value] of Object.entries({ MAINTENANCE_API_KEY: saved.key, MAINTENANCE_BASE_URL: saved.base, MAINTENANCE_MODEL: saved.model })) value === undefined ? delete process.env[key] : process.env[key] = value; };
afterEach(restore);

async function server(response: string | ((request: Request) => Response | Promise<Response>), init?: { status?: number }) {
  const instance = Bun.serve({ port: 0, fetch(request) {
    return typeof response === "function" ? response(request) : new Response(response, { status: init?.status ?? 200, headers: { "content-type": "application/json" } });
  }});
  return { instance, url: `http://127.0.0.1:${instance.port}/v1` };
}
function configure(url: string) { process.env.MAINTENANCE_API_KEY = "secret"; process.env.MAINTENANCE_BASE_URL = url; process.env.MAINTENANCE_MODEL = "test-model"; }
const messages = [{ role: "user" as const, content: "translate" }];

describe("strict model JSON client", () => {
  test("posts the exact OpenAI-compatible envelope and returns exact content bytes/hash", async () => {
    const content = '{"label":"Перевод"}';
    const { instance, url } = await server(request => {
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer secret");
      expect(request.headers.get("content-type")).toBe("application/json");
      return request.json().then(body => {
        expect(body).toEqual({ model: "test-model", messages, stream: false });
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { "content-type": "application/json" } });
      });
    });
    try {
      configure(url);
      await expect(requestModelJSON(messages)).resolves.toEqual({ value: { label: "Перевод" }, bytes: content, sha256: createHash("sha256").update(content).digest("hex") });
    } finally { instance.stop(); }
  });

  test("rejects credentials, query/fragment, non-loopback HTTP and duplicate JSON keys", async () => {
    for (const base of ["http://user:pass@127.0.0.1:1/v1", "http://127.0.0.1:1/v1?x=1", "http://127.0.0.1:1/v1#x", "http://example.com/v1"]) {
      process.env.MAINTENANCE_API_KEY = "secret"; process.env.MAINTENANCE_BASE_URL = base; process.env.MAINTENANCE_MODEL = "m";
      await expect(requestModelJSON(messages)).rejects.toThrow();
    }
    const { instance, url } = await server('{"choices":[{"message":{"content":"{\\"x\\":1,\\"x\\":2}"}}]}');
    try { configure(url); await expect(requestModelJSON(messages)).rejects.toThrow(); } finally { instance.stop(); }
  });

  test("rejects refusal/tool calls, HTTP errors, redirects, and oversized responses", async () => {
    for (const response of [
      JSON.stringify({ choices: [{ message: { refusal: "no" } }] }),
      JSON.stringify({ choices: [{ message: { content: "{}", tool_calls: [{ id: "call_1", type: "function", function: { name: "x", arguments: "{}" } }] } }] }),
    ]) {
      const { instance, url } = await server(response);
      try { configure(url); await expect(requestModelJSON(messages)).rejects.toThrow(); } finally { instance.stop(); }
    }
    const error = await server("provider details", { status: 500 });
    try { configure(error.url); await expect(requestModelJSON(messages)).rejects.toThrow(/model-http-500/); } finally { error.instance.stop(); }
  });
});
