/**
 * Reference solutions: a scripted "expert buyer" plays a hand-written correct
 * plan for every scenario through the real orchestrator. Every scenario must
 * pass the grader. This proves each scenario is solvable within policy and that
 * the grader isn't stricter than a competent human would be.
 */
import { describe, expect, it } from "vitest";
import { ScriptedClient, type LLMTurn } from "../src/agent/llm.js";
import { runAgent, type Approver } from "../src/agent/orchestrator.js";
import { RunStore } from "../src/agent/runs.js";
import { gradeRun } from "../src/eval/grader.js";
import { getScenario, SCENARIOS } from "../src/scenarios/index.js";

const approve: Approver = async () => ({ approved: true, by: "test" });
const N = "DS-BLR-01";

type P = Record<string, unknown>;
const po = (supplierId: string, quantity: number, deliveryDay?: number) => ({ type: "CREATE_PO", reason: "cover need", supplierId, quantity, deliveryDay });
const partial = (poId: string) => ({ type: "ACCEPT_PARTIAL", reason: "keep confirmed qty coming", poId });
const esc = (q: string) => ({ type: "ESCALATE", reason: "needs buyer", questionForBuyer: q });

const SOLUTIONS: Record<string, { plans: P[] }> = {
  "s1-accept": { plans: [{ decision: "ACCEPT", factors: "need 760 vs rec 800 within 10%", rate: 70, actions: [po("SUP-FRESHFIELDS", 800)], through: 10 }] },
  "s1-open-po": { plans: [{ decision: "MODIFY", factors: "open PO-2001 of 400 arriving day 2 was missed", rate: 50, actions: [po("SUP-METRO", 180)], through: 11 }] },
  "s1-reject": { plans: [{ decision: "REJECT", factors: "20 days of cover vs 8 day shelf-life limit; promo not in calendar", rate: 35, actions: [], through: 14 }] },
  "s1-forecast-anomaly": { plans: [{ decision: "INVESTIGATE", factors: "forecast driven by a one-off 930 unit b2b outlier day", rate: 30, actions: [esc("Confirm D-4 was a one-off institutional order and reset forecast to ~30/day?")], through: 12 }] },
  "s2-alternate-supplier": { plans: [{ decision: "MODIFY", factors: "250 only covers to day 7, stockout day 8", rate: 45, actions: [partial("PO-3001"), po("SUP-METRO", 200)], through: 10 }] },
  "s2-inventory-sufficient": { plans: [{ decision: "ACCEPT", factors: "600 + 250 covers 34 days", rate: 25, actions: [partial("PO-3101")], through: 21 }] },
  "s2-no-good-alternative": { plans: [{ decision: "ESCALATE", factors: "only alternate arrives day 12, stockout day 8", rate: 12, actions: [partial("PO-3201"), esc("Transfer stock from nearby stores or apply purchase limits?")] }] },
  "s2-feedback-loop": {
    plans: [
      { decision: "MODIFY", factors: "stockout day 8 with 250 only", rate: 45, actions: [partial("PO-3001"), po("SUP-METRO", 200)], through: 10 },
      { decision: "MODIFY", factors: "Metro confirmed only 100; stockout day 10", rate: 45, actions: [po("SUP-QUICK", 100)], through: 10 },
    ],
  },
  "s3-sustained-spike": { plans: [{ decision: "MODIFY", factors: "sustained trend: last 7 days ~88/day for 10 consecutive days, heatwave", rate: 90, actions: [po("SUP-METRO", 480)], through: 10 }] },
  "s3-promo-spike": { plans: [{ decision: "NO_CHANGE", factors: "spike explained by promotion that ended yesterday", rate: 50, actions: [], through: 10 }] },
  "s4-budget": { plans: [{ decision: "ESCALATE", factors: "only 2L budget remaining", rate: 80, actions: [po("SUP-METRO", 440), esc("Extend Staples budget by ~2.8L for remaining 620 units?")], maxCover: 8 }] },
  "s4-storage": { plans: [{ decision: "MODIFY", factors: "freezer capacity: only 400 units free", rate: 60, actions: [po("SUP-COLDCHAIN", 310), po("SUP-COLDCHAIN", 260, 7)], through: 7 }] },
};

function script(id: string): ScriptedClient {
  const s = getScenario(id);
  const { sku, nodeId, recommendationId, poId } = s.trigger.context;
  const product = s.world.products.find((p) => p.sku === sku)!;
  const reads: LLMTurn = {
    text: "",
    calls: [
      { name: "get_inventory_position", args: { sku, nodeId } },
      { name: "get_demand_signals", args: { sku, nodeId } },
      { name: "get_supplier_options", args: { sku } },
      { name: "get_budget", args: { category: product.category } },
      ...(recommendationId ? [{ name: "get_recommendation", args: { recommendationId } }] : []),
      ...(poId ? [{ name: "get_supplier_messages", args: { poId } }] : []),
    ],
  };
  const plans = SOLUTIONS[id].plans.map(
    (p): LLMTurn => ({
      text: "",
      calls: [
        {
          name: "submit_plan",
          args: {
            decision: p.decision,
            summary: String(p.factors),
            keyFactors: [{ factor: String(p.factors), evidence: String(p.factors) }],
            demandAssumption: { dailyRate: p.rate, basis: "reference" },
            actions: p.actions,
            expectedOutcome: p.through !== undefined ? { noStockoutThroughDay: p.through } : p.maxCover !== undefined ? { maxDaysOfCover: p.maxCover } : undefined,
            confidence: 0.9,
          },
        },
      ],
    }),
  );
  return new ScriptedClient("reference", [() => reads, ...plans.map((t) => () => t)]);
}

describe("reference solutions pass every scenario", () => {
  for (const s of SCENARIOS) {
    it(s.id, async () => {
      expect(SOLUTIONS[s.id], `missing reference solution for ${s.id}`).toBeDefined();
      const run = await runAgent(s, script(s.id), new RunStore(), approve);
      const g = gradeRun(s, run);
      const failures = g.dimensions.filter((d) => d.status === "FAIL").map((d) => `${d.key}: ${d.details.join("; ")}`);
      expect(failures, `${run.status} / guardrails: ${JSON.stringify(run.plans.map((p) => p.guardrail.findings))}`).toEqual([]);
      expect(g.passed).toBe(true);
      void N;
    });
  }
});
