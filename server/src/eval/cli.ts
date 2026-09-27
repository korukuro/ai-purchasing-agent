/**
 * npm run eval                          -> Gemini agent on all scenarios
 * npm run eval -- --scenario s2-feedback-loop,s1-open-po --trials 3
 * npm run eval -- --agent baseline      -> naive blind-executor baseline (no API key needed)
 */
import { runEval, saveReport, toMarkdown, type AgentKind } from "./runner.js";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const agent = (arg("agent") ?? "gemini") as AgentKind;
const scenarioIds = arg("scenario")?.split(",").map((s) => s.trim());
const trials = Number(arg("trials") ?? 1);

const report = await runEval({ agent, scenarioIds, trials, onProgress: (m) => console.log(m) });
saveReport(report, agent);
console.log("\n" + toMarkdown(report));
console.log(`Saved to server/eval-results/latest-${agent}.{json,md}`);
