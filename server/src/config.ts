import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Load ../.env (repo root) if present. Works on Windows/macOS/Linux without extra deps.
for (const rel of ["../../.env", "../.env"]) {
  const p = fileURLToPath(new URL(rel, import.meta.url));
  if (existsSync(p)) {
    try {
      process.loadEnvFile(p);
    } catch {
      /* ignore malformed .env */
    }
    break;
  }
}

const int = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  port: int(process.env.PORT, 8787),
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  /** Primary model first, then fallbacks used when a model's daily free-tier quota runs out. */
  geminiModels: (process.env.GEMINI_MODEL || "gemini-flash-latest,gemini-flash-lite-latest")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean),
  get geminiModel() {
    return this.geminiModels.join(" → ");
  },
  llmRpm: int(process.env.LLM_RPM, 5),
  maxLlmSteps: int(process.env.AGENT_MAX_LLM_STEPS, 30),
  maxReplans: int(process.env.AGENT_MAX_REPLANS, 2),
  maxGuardrailRejections: int(process.env.AGENT_MAX_GUARDRAIL_REJECTIONS, 3),
};
