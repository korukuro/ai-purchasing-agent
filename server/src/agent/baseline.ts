/**
 * Naive "blind executor" baseline: does exactly what the trigger says without
 * investigating (accept the recommendation, accept the supplier's partial
 * quantity, ignore demand alerts). It runs through the SAME orchestrator,
 * guardrails and verifier, and is graded by the same evaluator — which shows
 * the evaluation actually discriminates between good and bad behaviour.
 */
import { ScriptedClient, type LLMTurn } from "./llm.js";
import type { Scenario } from "../scenarios/types.js";
import { World } from "../domain/world.js";

export function naivePlan(s: Scenario): Record<string, unknown> {
  const c = s.trigger.context;
  const w = new World(s.world);
  if (c.recommendationId) {
    const rec = w.recommendation(c.recommendationId);
    return {
      decision: "ACCEPT",
      summary: `Accepting recommendation ${rec.id} as generated.`,
      keyFactors: [{ factor: "System recommendation", evidence: rec.rationale }],
      demandAssumption: { dailyRate: w.demand(c.sku, c.nodeId).forecast[0], basis: "system forecast" },
      actions: [{ type: "CREATE_PO", reason: "execute recommendation", supplierId: rec.supplierId, quantity: rec.qty }],
      confidence: 1,
    };
  }
  if (c.poId) {
    return {
      decision: "ACCEPT",
      summary: "Accepting the supplier's partial quantity.",
      keyFactors: [],
      demandAssumption: { dailyRate: w.demand(c.sku, c.nodeId).forecast[0], basis: "system forecast" },
      actions: [{ type: "ACCEPT_PARTIAL", reason: "supplier can only ship part", poId: c.poId }],
      confidence: 1,
    };
  }
  return {
    decision: "NO_CHANGE",
    summary: "Existing PO already in place.",
    keyFactors: [],
    demandAssumption: { dailyRate: w.demand(c.sku, c.nodeId).forecast[0], basis: "system forecast" },
    actions: [],
    confidence: 1,
  };
}

export function baselineClient(s: Scenario) {
  const submit = (): LLMTurn => ({ text: "", calls: [{ name: "submit_plan", args: naivePlan(s) }] });
  // After the first submission it just says "done" (it never re-plans).
  return new ScriptedClient("baseline:blind-executor", [submit], () => ({ text: "Done.", calls: [] }));
}
