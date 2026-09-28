/**
 * Preflight check for the LLM: is the key set, does the model exist, is there
 * quota left? Fails fast with an actionable message instead of a silent/long eval.
 * Run on its own with:  npm run check-llm
 */
import { config } from "../config.js";
import { explainLLMError, GeminiClient, listGenerateModels } from "../agent/llm.js";

export async function preflight(log: (m: string) => void = console.log): Promise<boolean> {
  if (!config.geminiApiKey) {
    log("✘ GEMINI_API_KEY is not set. Copy .env.example to .env (in the repo root) and add your key.");
    return false;
  }
  log(`• key loaded (${config.geminiApiKey.length} chars), model "${config.geminiModel}", client rate limit ${config.llmRpm} req/min`);
  try {
    const turn = await new GeminiClient(config.geminiApiKey, config.geminiModel, 600).generate(
      "You are a health check. Reply with the single word OK.",
      [{ role: "user", text: "ping" }],
      [],
    );
    log(`✔ Gemini responded: "${turn.text.slice(0, 40)}"`);
    return true;
  } catch (err) {
    log(`✘ Gemini call failed: ${explainLLMError(err, config.geminiModel) ?? String((err as Error)?.message ?? err)}`);
    try {
      const models = (await listGenerateModels()).filter((m) => /flash|pro/.test(m) && !/tts|image|live|audio|embed/.test(m));
      if (models.length) log(`  Models this key can use (set GEMINI_MODEL in .env to one of them):\n   - ${models.join("\n   - ")}`);
    } catch {
      /* listing needs the same key; ignore if that fails too */
    }
    return false;
  }
}

