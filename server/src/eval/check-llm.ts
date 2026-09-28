// npm run check-llm — verifies GEMINI_API_KEY / GEMINI_MODEL with one tiny request.
import { preflight } from "./preflight.js";

process.exit((await preflight()) ? 0 : 1);
