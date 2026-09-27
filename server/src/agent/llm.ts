/**
 * Provider-agnostic LLM interface + Gemini implementation.
 * The orchestrator only depends on LLMClient, so swapping providers (or
 * using a scripted client in tests / the naive baseline) is a one-liner.
 */
import { GoogleGenAI, type Content, type Part } from "@google/genai";
import { config } from "../config.js";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema (object)
}

export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export type Message =
  | { role: "user"; text: string }
  | { role: "model"; text: string; calls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: { id?: string; name: string; response: unknown }[] };

export interface LLMTurn {
  text: string;
  calls: ToolCall[];
  raw?: unknown;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LLMClient {
  readonly name: string;
  generate(system: string, history: Message[], tools: ToolSpec[]): Promise<LLMTurn>;
}

// ---------------------------------------------------------------------------
// Rate limiting + retries (free tiers are tight on RPM)
// ---------------------------------------------------------------------------

class RateLimiter {
  private next = 0;
  constructor(private rpm: number) {}
  async wait() {
    const gap = 60_000 / Math.max(1, this.rpm);
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + gap;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryDelayMs(err: unknown, attempt: number): number | null {
  const msg = String((err as Error)?.message ?? err);
  const status = (err as { status?: number })?.status;
  const retryable = status === 429 || status === 500 || status === 503 || /429|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|ECONNRESET|fetch failed/i.test(msg);
  if (!retryable) return null;
  const m = msg.match(/retry(?:Delay)?[^0-9]{0,20}(\d+(?:\.\d+)?)s/i);
  if (m) return Math.ceil(Number(m[1]) * 1000) + 500;
  return Math.min(60_000, 2_000 * 2 ** attempt);
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

export class GeminiClient implements LLMClient {
  readonly name: string;
  private ai: GoogleGenAI;
  private limiter: RateLimiter;

  constructor(apiKey = config.geminiApiKey, private model = config.geminiModel, rpm = config.llmRpm) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.");
    this.ai = new GoogleGenAI({ apiKey });
    this.limiter = new RateLimiter(rpm);
    this.name = `gemini:${model}`;
  }

  private toContents(history: Message[]): Content[] {
    return history.map((m): Content => {
      if (m.role === "user") return { role: "user", parts: [{ text: m.text }] };
      if (m.role === "model") {
        // Send the model's own content back verbatim: this preserves thought signatures.
        if (m.raw) return m.raw as Content;
        const parts: Part[] = [];
        if (m.text) parts.push({ text: m.text });
        for (const c of m.calls) parts.push({ functionCall: { id: c.id, name: c.name, args: c.args } });
        return { role: "model", parts };
      }
      return {
        role: "user",
        parts: m.results.map((r) => ({
          functionResponse: { id: r.id, name: r.name, response: { result: r.response } },
        })),
      };
    });
  }

  async generate(system: string, history: Message[], tools: ToolSpec[]): Promise<LLMTurn> {
    const contents = this.toContents(history);
    for (let attempt = 0; ; attempt++) {
      await this.limiter.wait();
      try {
        const res = await this.ai.models.generateContent({
          model: this.model,
          contents,
          config: {
            systemInstruction: system,
            tools: [
              {
                functionDeclarations: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parametersJsonSchema: t.parameters,
                })),
              },
            ],
          },
        });
        const content = res.candidates?.[0]?.content;
        const parts = content?.parts ?? [];
        const text = parts
          .filter((p) => p.text && !p.thought)
          .map((p) => p.text)
          .join("\n")
          .trim();
        const calls: ToolCall[] = (res.functionCalls ?? []).map((c) => ({
          id: c.id,
          name: c.name ?? "",
          args: (c.args ?? {}) as Record<string, unknown>,
        }));
        return {
          text,
          calls,
          raw: content ? { role: "model", parts } : undefined,
          usage: {
            inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0),
          },
        };
      } catch (err) {
        const delay = retryDelayMs(err, attempt);
        if (delay === null || attempt >= 5) throw err;
        await sleep(delay);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Scripted client — deterministic, used by unit tests and the naive baseline
// ---------------------------------------------------------------------------

export type ScriptStep = (history: Message[]) => LLMTurn;

export class ScriptedClient implements LLMClient {
  private i = 0;
  constructor(
    readonly name: string,
    private steps: ScriptStep[],
    private fallback?: ScriptStep,
  ) {}
  async generate(_system: string, history: Message[]): Promise<LLMTurn> {
    const step = this.steps[this.i++] ?? this.fallback;
    if (!step) return { text: "script exhausted", calls: [] };
    return step(history);
  }
}
