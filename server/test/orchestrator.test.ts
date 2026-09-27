/**
 * Orchestrator tests with a scripted LLM: they exercise the control flow
 * (guardrail retry loop, approval gate, verification → re-plan loop, bounded
 * retries) deterministically and without network.
 */
import { describe, expect, it } from "vitest";
import { ScriptedClient, type LLMTurn, type Message } from "../src/agent/llm.js";
import { runAgent, type Approver } from "../src/agent/orchestrator.js";
import { RunStore } from "../src/agent/runs.js";
import { baselineClient } from "../src/agent/baseline.js";
import { gradeRun } from "../src/eval/grader.js";
import { getScenario } from "../src/scenarios/index.js";

const approve: Approver = async () => ({ approved: true, by: "test" });
const call = (name: string, args: Record<string, unknown>): LLMTurn => ({ text: "", calls: [{ id: name, name, args }] });
const lastToolResponse = (h: Message[]) => {
  const m = [...h].reverse().find((x) => x.role === "tool");
  return m && m.role === "tool" ? (m.results.at(-1)!.response as any) : undefined;
};

const investigate = [
  () => call("get_supplier_messages", { poId: "PO-3001" }),
  () => call("get_inventory_position", { sku: "OIL-MUSTARD-1L", nodeId: "DS-BLR-01" }),
  () => call("get_demand_signals", { sku: "OIL-MUSTARD-1L", nodeId: "DS-BLR-01" }),
  () => call("get_supplier_options", { sku: "OIL-MUSTARD-1L" }),
];

describe("orchestrator feedback loop", () => {
  it("re-plans after verification detects an under-delivering supplier", async () => {
    const s = getScenario("s2-feedback-loop");
    const seen: any[] = [];
    const llm = new ScriptedClient("scripted", [
      ...investigate,
      () =>
        call("submit_plan", {
          decision: "MODIFY",
          summary: "Accept 250 and buy 200 from Metro to avoid the day-8 stockout.",
          keyFactors: [{ factor: "stockout", evidence: "day 8" }],
          demandAssumption: { dailyRate: 45, basis: "forecast matches sales" },
          actions: [
            { type: "ACCEPT_PARTIAL", reason: "keep 250 coming", poId: "PO-3001", quantity: 250 },
            { type: "CREATE_PO", reason: "cover gap", supplierId: "SUP-METRO", quantity: 200 },
          ],
          expectedOutcome: { noStockoutThroughDay: 10 },
          confidence: 0.8,
        }),
      (h) => {
        seen.push(lastToolResponse(h));
        return call("submit_plan", {
          decision: "MODIFY",
          summary: "Metro only confirmed 100; top up 100 from QuickSupply.",
          keyFactors: [{ factor: "supplier shortfall", evidence: "Metro confirmed 100/200" }],
          demandAssumption: { dailyRate: 45, basis: "forecast" },
          actions: [{ type: "CREATE_PO", reason: "cover remaining gap", supplierId: "SUP-QUICK", quantity: 100 }],
          expectedOutcome: { noStockoutThroughDay: 10 },
          confidence: 0.8,
        });
      },
    ]);
    const run = await runAgent(s, llm, new RunStore(), approve);
    expect(seen[0].status).toBe("EXECUTED_WITH_DEVIATIONS");
    expect(run.status).toBe("COMPLETED");
    expect(run.plans).toHaveLength(2);
    expect(run.metrics.replans).toBe(1);
    const g = gradeRun(s, run);
    expect(g.dimensions.find((d) => d.key === "recovery")!.status).toBe("PASS");
    expect(g.passed).toBe(true);
  });

  it("sends guardrail violations back and accepts the corrected plan", async () => {
    const s = getScenario("s4-storage");
    const base = {
      decision: "MODIFY",
      summary: "freezer space limits the order",
      keyFactors: [{ factor: "storage capacity", evidence: "400 free" }],
      demandAssumption: { dailyRate: 60, basis: "forecast" },
      expectedOutcome: { noStockoutThroughDay: 7 },
      confidence: 0.7,
    };
    let feedback: any;
    const llm = new ScriptedClient("scripted", [
      () => call("get_inventory_position", { sku: "PEAS-FROZEN-1KG", nodeId: "DS-BLR-01" }),
      () => call("submit_plan", { ...base, actions: [{ type: "CREATE_PO", reason: "", supplierId: "SUP-COLDCHAIN", quantity: 800 }] }),
      (h) => {
        feedback = lastToolResponse(h);
        return call("submit_plan", { ...base, actions: [{ type: "CREATE_PO", reason: "", supplierId: "SUP-COLDCHAIN", quantity: 310 }] });
      },
    ]);
    const run = await runAgent(s, llm, new RunStore(), approve);
    expect(feedback.status).toBe("BLOCKED_BY_GUARDRAILS");
    expect(feedback.violations.map((v: any) => v.code)).toContain("STORAGE_CAPACITY");
    expect(run.status).toBe("COMPLETED");
    expect(run.metrics.guardrailRejections).toBe(1);
  });

  it("waits for buyer approval and feeds a rejection back to the agent", async () => {
    const s = getScenario("s4-budget");
    const plan = (qty: number) => ({
      decision: "ESCALATE",
      summary: "budget only allows part of the need",
      keyFactors: [{ factor: "budget", evidence: "₹2L left" }],
      demandAssumption: { dailyRate: 80, basis: "forecast" },
      actions: [
        { type: "CREATE_PO", reason: "", supplierId: "SUP-METRO", quantity: qty },
        { type: "ESCALATE", reason: "budget", questionForBuyer: "Extend Staples budget by ₹2.8L?" },
      ],
      confidence: 0.7,
    });
    let feedback: any;
    const llm = new ScriptedClient("scripted", [
      () => call("submit_plan", plan(440)),
      (h) => {
        feedback = lastToolResponse(h);
        return call("submit_plan", plan(320));
      },
    ]);
    let asked = 0;
    const approver: Approver = async () => (++asked === 1 ? { approved: false, by: "buyer", comment: "keep it under ₹1.5L" } : { approved: true, by: "buyer" });
    const run = await runAgent(s, llm, new RunStore(), approver);
    expect(asked).toBe(1); // 320 units = ₹1.44L -> no approval needed on the retry
    expect(feedback.status).toBe("REJECTED_BY_BUYER");
    expect(run.status).toBe("COMPLETED");
  });

  it("bounds the retry loop and escalates when the agent keeps submitting blocked plans", async () => {
    const s = getScenario("s1-reject");
    const run = await runAgent(s, baselineClient(s), new RunStore(), approve, { maxGuardrailRejections: 1 });
    expect(run.status).toBe("ESCALATED");
    expect(run.worldAfter!.escalations.some((e) => e.reason.startsWith("[system]"))).toBe(true);
  });
});

describe("evaluator", () => {
  it("fails the blind-executor baseline on the stale-forecast scenario", async () => {
    const s = getScenario("s3-sustained-spike");
    const run = await runAgent(s, baselineClient(s), new RunStore(), approve);
    const g = gradeRun(s, run);
    expect(g.passed).toBe(false);
    expect(g.dimensions.find((d) => d.key === "decision")!.status).toBe("FAIL");
  });
});
