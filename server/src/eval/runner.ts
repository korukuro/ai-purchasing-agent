import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { baselineClient } from "../agent/baseline.js";
import { GeminiClient, type LLMClient } from "../agent/llm.js";
import { runAgent, type Approver } from "../agent/orchestrator.js";
import { RunStore } from "../agent/runs.js";
import { SCENARIOS } from "../scenarios/index.js";
import type { Scenario } from "../scenarios/types.js";
import { gradeRun, type Grade } from "./grader.js";

export type AgentKind = "gemini" | "baseline";

export interface EvalReport {
  agent: string;
  startedAt: string;
  finishedAt: string;
  trials: number;
  grades: Grade[];
  summary: {
    scenarios: number;
    runs: number;
    passRate: number;
    avgScore: number;
    byDimension: Record<string, { pass: number; fail: number; na: number }>;
    byScenario: Record<string, { passes: number; runs: number }>;
    avgLlmCalls: number;
    avgToolCalls: number;
    totalTokens: number;
  };
}

/** Simulated buyer used during evaluation: approves any plan that passed guardrails. */
export const autoApprover: Approver = async () => ({ approved: true, by: "eval-auto-approver", comment: "auto-approved in evaluation" });

export function makeClient(kind: AgentKind, s: Scenario): LLMClient {
  return kind === "baseline" ? baselineClient(s) : new GeminiClient();
}

export async function runEval(opts: {
  agent: AgentKind;
  scenarioIds?: string[];
  trials?: number;
  store?: RunStore;
  onProgress?: (msg: string, grade?: Grade) => void;
}): Promise<EvalReport> {
  const store = opts.store ?? new RunStore();
  const trials = opts.trials ?? 1;
  const scenarios = opts.scenarioIds?.length ? SCENARIOS.filter((s) => opts.scenarioIds!.includes(s.id)) : SCENARIOS;
  const startedAt = new Date().toISOString();
  const grades: Grade[] = [];

  for (const s of scenarios) {
    for (let t = 0; t < trials; t++) {
      opts.onProgress?.(`▶ ${s.id} (trial ${t + 1}/${trials})`);
      const run = await runAgent(s, makeClient(opts.agent, s), store, autoApprover);
      const g = gradeRun(s, run);
      grades.push(g);
      opts.onProgress?.(`${g.passed ? "✔" : "✘"} ${s.id}: ${g.finalDecision}, score ${g.score}`, g);
    }
  }

  const byDimension: EvalReport["summary"]["byDimension"] = {};
  const byScenario: EvalReport["summary"]["byScenario"] = {};
  for (const g of grades) {
    byScenario[g.scenarioId] ??= { passes: 0, runs: 0 };
    byScenario[g.scenarioId].runs++;
    if (g.passed) byScenario[g.scenarioId].passes++;
    for (const d of g.dimensions) {
      byDimension[d.key] ??= { pass: 0, fail: 0, na: 0 };
      byDimension[d.key][d.status === "PASS" ? "pass" : d.status === "FAIL" ? "fail" : "na"]++;
    }
  }
  const avg = (f: (g: Grade) => number) => Math.round((10 * grades.reduce((s, g) => s + f(g), 0)) / Math.max(1, grades.length)) / 10;

  return {
    agent: grades[0]?.agent ?? opts.agent,
    startedAt,
    finishedAt: new Date().toISOString(),
    trials,
    grades,
    summary: {
      scenarios: scenarios.length,
      runs: grades.length,
      passRate: Math.round((100 * grades.filter((g) => g.passed).length) / Math.max(1, grades.length)) / 100,
      avgScore: Math.round((100 * grades.reduce((s, g) => s + g.score, 0)) / Math.max(1, grades.length)) / 100,
      byDimension,
      byScenario,
      avgLlmCalls: avg((g) => g.metrics.llmCalls),
      avgToolCalls: avg((g) => g.metrics.toolCalls),
      totalTokens: grades.reduce((s, g) => s + g.metrics.inputTokens + g.metrics.outputTokens, 0),
    },
  };
}

export const RESULTS_DIR = fileURLToPath(new URL("../../eval-results/", import.meta.url));

export function toMarkdown(r: EvalReport): string {
  const dims = ["decision", "information", "constraints", "action", "validation", "recovery", "explanation"];
  const icon = (s: string) => (s === "PASS" ? "✅" : s === "FAIL" ? "❌" : "—");
  const lines = [
    `# Evaluation report — ${r.agent}`,
    "",
    `Run ${r.startedAt} · ${r.summary.runs} run(s) over ${r.summary.scenarios} scenario(s) · ${r.trials} trial(s) each`,
    "",
    `**Pass rate: ${Math.round(r.summary.passRate * 100)}%** · average dimension score ${Math.round(r.summary.avgScore * 100)}% · avg ${r.summary.avgLlmCalls} LLM calls / ${r.summary.avgToolCalls} tool calls per run`,
    "",
    `| Scenario | Decision | New units | ${dims.join(" | ")} | Pass |`,
    `|---|---|---|${dims.map(() => "---").join("|")}|---|`,
    ...r.grades.map((g) => `| ${g.scenarioId} | ${g.finalDecision} | ${g.newUnits} | ${dims.map((k) => icon(g.dimensions.find((d) => d.key === k)!.status)).join(" | ")} | ${g.passed ? "✅" : "❌"} |`),
    "",
    "## Failures",
    "",
    ...r.grades.flatMap((g) =>
      g.dimensions
        .filter((d) => d.status === "FAIL")
        .map((d) => `- **${g.scenarioId}** · ${d.label} — ${d.details.join("; ")}`),
    ),
  ];
  return lines.join("\n") + "\n";
}

export function saveReport(r: EvalReport, kind: AgentKind) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(`${RESULTS_DIR}latest-${kind}.json`, JSON.stringify(r, null, 2));
  writeFileSync(`${RESULTS_DIR}latest-${kind}.md`, toMarkdown(r));
}
