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

// One limiter per RPM value, shared by every client in the process (the quota is per key, not per run).
const limiters = new Map<number, RateLimiter>();
const sharedLimiter = (rpm: number) => limiters.get(rpm) ?? limiters.set(rpm, new RateLimiter(rpm)).get(rpm)!;

// Models whose free-tier DAILY quota is used up in this process; every client skips them.
const exhaustedModels = new Set<string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thrown when retrying cannot help (bad key, unknown model, daily quota used up). */
export class FatalLLMError extends Error {}

/** Turn raw API errors into something a human can act on. */
export function explainLLMError(err: unknown, model: string): string | null {
  if (err instanceof FatalLLMError) return err.message;
  const msg = String((err as Error)?.message ?? err);
  if (/allowlist|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|getaddrinfo|network/i.test(msg))
    return `Could not reach generativelanguage.googleapis.com (${msg.slice(0, 160)}). Check your internet connection, VPN, proxy or firewall.`;
  if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED|unauthenticated|401|403/i.test(msg))
    return `Gemini rejected the API key (${msg.slice(0, 160)}). Check GEMINI_API_KEY in .env (create one at https://aistudio.google.com/apikey).`;
  if (/not found|404|is not supported for generateContent/i.test(msg))
    return `Model "${model}" is not available for this key (${msg.slice(0, 160)}). Set GEMINI_MODEL in .env to one of the models listed by "npm run check-llm".`;
  if (/PerDay|per day|daily/i.test(msg))
    return `The free-tier DAILY quota for "${model}" is used up (resets at midnight Pacific). Try another model via GEMINI_MODEL (e.g. a flash-lite model), or run fewer scenarios with --scenario.`;
  return null;
}

function retryDelayMs(err: unknown, attempt: number): number | null {
  const msg = String((err as Error)?.message ?? err);
  if (/PerDay|per day/i.test(msg)) return null; // daily quota: waiting a few seconds won't help
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
  /** Optional hook so the CLI can show that we're waiting on rate limits instead of looking frozen. */
  onRetry?: (msg: string) => void;

  private models: string[];

  /**
   * @param models one model id or a fallback chain (e.g. "gemini-flash-latest,gemini-flash-lite-latest").
   *               When a model's daily free-tier quota runs out, the client moves to the next one.
   */
  constructor(apiKey = config.geminiApiKey, models: string | string[] = config.geminiModels, rpm = config.llmRpm) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.");
    this.ai = new GoogleGenAI({ apiKey });
    this.models = (Array.isArray(models) ? models : models.split(",")).map((m) => m.trim()).filter(Boolean);
    this.limiter = sharedLimiter(rpm);
    this.name = `gemini:${this.models[0]}`;
  }

  private get model(): string {
    return this.models.find((m) => !exhaustedModels.has(m)) ?? this.models[this.models.length - 1];
  }

  private toContents(history: Message[]): Content[] {
    return history.map((m): Content => {
      if (m.role === "user") return { role: "user", parts: [{ text: m.text }] };
      if (m.role === "model") {
        // Send the model's own content back verbatim: this preserves thought signatures.
        const raw = m.raw as (Content & { producedBy?: string }) | undefined;
        if (raw && raw.producedBy === this.model) return { role: "model", parts: raw.parts };
        if (raw) {
          // Produced by a different model (we fell back mid-run): its thought signatures are not valid here.
          const parts = (raw.parts ?? [])
            .filter((p) => !p.thought)
            .map((p) => (p.functionCall ? { functionCall: p.functionCall, thoughtSignature: "skip_thought_signature_validator" } : { text: p.text }));
          return { role: "model", parts };
        }
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
    for (let attempt = 0; ; attempt++) {
      const model = this.model;
      const contents = this.toContents(history);
      await this.limiter.wait();
      try {
        const res = await this.ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: system,
            tools: tools.length
              ? [
                  {
                    functionDeclarations: tools.map((t) => ({
                      name: t.name,
                      description: t.description,
                      parametersJsonSchema: t.parameters,
                    })),
                  },
                ]
              : undefined,
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
          raw: content ? { role: "model", parts, producedBy: model } : undefined,
          usage: {
            inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0),
          },
        };
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (/PerDay|per day/i.test(msg) && !exhaustedModels.has(model)) {
          exhaustedModels.add(model);
          const next = this.models.find((m) => !exhaustedModels.has(m));
          if (next) {
            this.onRetry?.(`daily quota for ${model} is used up — switching to ${next}`);
            attempt = -1;
            continue;
          }
        }
        const delay = retryDelayMs(err, attempt);
        if (delay === null || attempt >= 8) {
          const explained = explainLLMError(err, model);
          if (explained) throw new FatalLLMError(explained);
          throw err;
        }
        this.onRetry?.(`LLM call failed (${String((err as Error)?.message ?? err).slice(0, 120)}), retrying in ${Math.round(delay / 1000)}s`);
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

/** List models this key can call generateContent on (used by the preflight check). */
export async function listGenerateModels(apiKey = config.geminiApiKey): Promise<string[]> {
  const ai = new GoogleGenAI({ apiKey });
  const out: string[] = [];
  const pager = await ai.models.list();
  for await (const m of pager) {
    const actions = (m as { supportedActions?: string[] }).supportedActions ?? [];
    if (!actions.length || actions.includes("generateContent")) out.push(String(m.name).replace(/^models\//, ""));
  }
  return out;
}
