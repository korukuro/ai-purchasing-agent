import { config } from "./config.js";
import { createApp } from "./api/app.js";

createApp().listen(config.port, () => {
  console.log(`AI Purchasing Agent API on http://localhost:${config.port}`);
  console.log(config.geminiApiKey ? `LLM: ${config.geminiModel} (${config.llmRpm} rpm)` : "LLM: GEMINI_API_KEY not set — only the baseline agent can run");
});
