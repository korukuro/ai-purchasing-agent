/**
 * Offline contract test for the Gemini client: intercepts fetch to check the
 * request we send (tools, system instruction, function responses, preserved
 * thought signatures) and that a function-call response is parsed correctly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiClient, type Message } from "../src/agent/llm.js";
import { TOOL_SPECS } from "../src/agent/tools.js";

afterEach(() => vi.unstubAllGlobals());

describe("GeminiClient", () => {
  it("sends tools + history in Gemini format and parses function calls", async () => {
    const bodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    { text: "thinking", thought: true },
                    { functionCall: { name: "get_budget", args: { category: "Staples" } }, thoughtSignature: "sig-123" },
                  ],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const client = new GeminiClient("test-key", "gemini-test", 60_000);
    const history: Message[] = [{ role: "user", text: "task" }];
    const turn = await client.generate("system prompt", history, TOOL_SPECS);

    expect(turn.calls).toEqual([{ id: undefined, name: "get_budget", args: { category: "Staples" } }]);
    expect(turn.text).toBe(""); // thought parts are not surfaced as text
    expect(turn.usage).toEqual({ inputTokens: 100, outputTokens: 25 });

    const req = bodies[0];
    expect(req.systemInstruction.parts[0].text).toBe("system prompt");
    const decls = req.tools[0].functionDeclarations;
    expect(decls.map((d: any) => d.name)).toContain("submit_plan");
    expect(decls.find((d: any) => d.name === "simulate_plan").parametersJsonSchema.type).toBe("object");

    // second turn: model content is echoed verbatim (thought signature kept) + function response
    history.push({ role: "model", text: turn.text, calls: turn.calls, raw: turn.raw });
    history.push({ role: "tool", results: [{ name: "get_budget", response: { remaining: 200000 } }] });
    await client.generate("system prompt", history, TOOL_SPECS);
    const contents = bodies[1].contents;
    expect(contents).toHaveLength(3);
    expect(contents[1].role).toBe("model");
    expect(contents[1].parts[1].thoughtSignature).toBe("sig-123");
    expect(contents[2].parts[0].functionResponse).toEqual({ name: "get_budget", response: { result: { remaining: 200000 } } });
  });

  it("retries on 429 using the server-provided delay", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (n++ === 0) {
          return new Response(JSON.stringify({ error: { code: 429, message: "Quota exceeded. Please retry in 0.01s.", status: "RESOURCE_EXHAUSTED" } }), { status: 429, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const turn = await new GeminiClient("k", "m", 60_000).generate("s", [{ role: "user", text: "hi" }], []);
    expect(turn.text).toBe("ok");
    expect(n).toBe(2);
  });

  it("falls back to the next model when the daily quota is exhausted", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        if (String(url).includes("primary-model")) {
          return new Response(JSON.stringify({ error: { code: 429, message: "Quota exceeded for quota metric GenerateRequestsPerDayPerProjectPerModel-FreeTier", status: "RESOURCE_EXHAUSTED" } }), { status: 429, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "from fallback" }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const client = new GeminiClient("k", "primary-model,fallback-model", 60_000);
    const notes: string[] = [];
    client.onRetry = (m) => notes.push(m);
    const turn = await client.generate("s", [{ role: "user", text: "hi" }], []);
    expect(turn.text).toBe("from fallback");
    expect(urls.some((u) => u.includes("fallback-model"))).toBe(true);
    expect(notes[0]).toMatch(/switching to fallback-model/);
  });
});
