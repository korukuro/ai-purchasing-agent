/**
 * npm run eval                          -> Gemini agent on all scenarios
 * npm run eval -- --scenario s2-feedback-loop,s1-open-po --trials 3
 * npm run eval -- --agent baseline      -> naive blind-executor baseline (no API key needed)
 */
import { config } from "../config.js";
import { RunStore } from "../agent/runs.js";
import { SCENARIOS } from "../scenarios/index.js";
import { preflight } from "./preflight.js";
import { RESULTS_DIR, runEval, saveReport, toMarkdown, type AgentKind } from "./runner.js";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const agent = (arg("agent") ?? "gemini") as AgentKind;
const scenarioIds = arg("scenario")?.split(",").map((s) => s.trim());
const trials = Number(arg("trials") ?? 1);
const quiet = args.includes("--quiet");

if (agent === "gemini") {
  console.log("Checking Gemini access…");
  if (!(await preflight())) process.exit(1);
  const n = (scenarioIds?.length ?? SCENARIOS.length) * trials;
  const perCall = 60 / Math.max(1, config.llmRpm);
  console.log(
    `\nRunning ${n} scenario run(s). Each run makes ~8–15 LLM calls, spaced ${perCall.toFixed(0)}s apart by the rate limiter,` +
      ` so expect roughly ${Math.round((n * 10 * perCall) / 60)} min. Results are saved after every scenario.\n`,
  );
}

// Live progress: one line per agent step so the terminal never looks frozen.
const store = new RunStore(
  quiet
    ? undefined
    : (_run, ev) => {
        if (ev.type === "tool_call") console.log(`   · ${ev.title}`);
        else if (["plan_submitted", "guardrail", "approval_requested", "verification", "feedback", "error"].includes(ev.type)) console.log(`   → ${ev.title}`);
      },
);

const report = await runEval({
  agent,
  scenarioIds,
  trials,
  store,
  onProgress: (m) => console.log(m),
  onPartial: (r) => saveReport(r, agent),
});
saveReport(report, agent);
console.log("\n" + toMarkdown(report));
console.log(`Saved to ${RESULTS_DIR}latest-${agent}.md (and .json)`);
