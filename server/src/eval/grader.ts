/**
 * Deterministic grader. Scores a finished run against the scenario's ground
 * truth on the dimensions the assignment asks about. It only uses the run
 * trace + the before/after world state — never the agent's own claims.
 */
import { projectInventory } from "../domain/planning.js";
import { World } from "../domain/world.js";
import type { Run } from "../agent/runs.js";
import type { Scenario } from "../scenarios/types.js";

export type DimensionKey =
  | "decision"
  | "information"
  | "constraints"
  | "action"
  | "validation"
  | "recovery"
  | "explanation";

export interface DimensionResult {
  key: DimensionKey;
  label: string;
  status: "PASS" | "FAIL" | "N/A";
  details: string[];
}

export interface Grade {
  scenarioId: string;
  runId: string;
  agent: string;
  runStatus: Run["status"];
  finalDecision: string;
  newUnits: number;
  passed: boolean;
  score: number; // passed / applicable
  dimensions: DimensionResult[];
  metrics: Run["metrics"];
}

const LABELS: Record<DimensionKey, string> = {
  decision: "Was the decision correct?",
  information: "Did it obtain the necessary information?",
  constraints: "Did it respect constraints?",
  action: "Did it take the appropriate action?",
  validation: "Did it validate the result?",
  recovery: "Did it handle a failed / blocked action?",
  explanation: "Did it explain the important factors?",
};

export function newUnitsSecured(before: World, after: World, sku: string, nodeId: string): number {
  const eff = (w: World) => {
    const m = new Map<string, number>();
    for (const po of w.state.purchaseOrders) if (po.sku === sku && po.nodeId === nodeId) m.set(po.id, World.effectiveInboundQty(po));
    return m;
  };
  const b = eff(before);
  const a = eff(after);
  let delta = 0;
  for (const [id, q] of a) delta += q - (b.get(id) ?? 0);
  for (const [id, q] of b) if (!a.has(id)) delta -= q;
  return delta;
}

export function gradeRun(s: Scenario, run: Run): Grade {
  const e = s.expectations;
  const { sku, nodeId } = s.trigger.context;
  const before = new World(run.worldBefore ?? s.world);
  const after = new World(run.worldAfter ?? s.world);
  const executedPlans = run.plans.filter((p) => p.execution);
  const finalPlan = executedPlans.at(-1)?.plan;
  const finalDecision = finalPlan?.decision ?? "NONE";
  const executedActions = executedPlans.flatMap((p) => p.plan.actions);
  const agentEscalations = after.state.escalations.filter((x) => x.sku === sku && !x.reason.startsWith("[system]"));
  const systemEscalations = after.state.escalations.filter((x) => x.sku === sku && x.reason.startsWith("[system]"));
  const newUnits = newUnitsSecured(before, after, sku, nodeId);
  const dims: DimensionResult[] = [];
  const dim = (key: DimensionKey, status: DimensionResult["status"], details: string[]) => dims.push({ key, label: LABELS[key], status, details });

  // 1. decision
  dim("decision", e.allowedDecisions.includes(finalDecision as never) ? "PASS" : "FAIL", [
    `final decision ${finalDecision}; acceptable: ${e.allowedDecisions.join(" / ")}`,
  ]);

  // 2. information
  const called = new Set(run.toolCalls.map((t) => t.name));
  const missing = e.requiredEvidence.filter((r) => !r.anyOf.some((t) => called.has(t)));
  dim("information", missing.length ? "FAIL" : "PASS", missing.length ? missing.map((m) => `never checked ${m.why} (${m.anyOf.join(" | ")})`) : [`checked: ${e.requiredEvidence.map((r) => r.why).join(", ")}`]);

  // 3. constraints — evaluated on the resulting state, not on the agent's claims
  const product = after.product(sku);
  const budget = after.budget(product.category);
  const trueProj = projectInventory(after, sku, nodeId, { dailyDemand: e.trueDailyDemand });
  const cDetails: string[] = [];
  let cOk = true;
  if (budget.committed > budget.limit) (cOk = false), cDetails.push(`budget exceeded: ${budget.committed} > ${budget.limit}`);
  if (trueProj.storage.exceedsCapacity) (cOk = false), cDetails.push(`storage exceeded: peak ${trueProj.peakStock} > ${trueProj.storage.freeCapacityForThisSku}`);
  if (product.shelfLifeDays && newUnits > 0 && trueProj.daysOfCoverTotal > product.shelfLifeDays * after.policy.perishableCoverFraction) (cOk = false), cDetails.push(`perishable over-cover ${trueProj.daysOfCoverTotal}d`);
  for (const p of executedPlans) {
    for (const a of p.plan.actions.filter((x) => x.type === "CREATE_PO")) {
      const offer = after.offer(a.supplierId!, sku);
      if (offer && (a.quantity! < offer.moq || a.quantity! % offer.caseSize)) (cOk = false), cDetails.push(`MOQ/case violated on ${a.supplierId}`);
    }
    if (p.guardrail.requiresApproval && !p.approval) (cOk = false), cDetails.push("approval-required plan executed without approval");
  }
  dim("constraints", cOk ? "PASS" : "FAIL", cOk ? ["budget, storage, shelf life, MOQ/case and approval rules respected"] : cDetails);

  // 4. action
  const aDetails: string[] = [];
  let aOk = true;
  const [lo, hi] = e.newUnitsRange;
  if (newUnits < lo || newUnits > hi) (aOk = false), aDetails.push(`net new units ${newUnits} outside expected [${lo}, ${hi}]`);
  else aDetails.push(`net new units ${newUnits} within [${lo}, ${hi}]`);
  for (const t of e.requiredActionTypes ?? []) {
    if (!executedActions.some((a) => a.type === t)) (aOk = false), aDetails.push(`missing required action ${t}`);
  }
  if (e.mustEscalate && !agentEscalations.length) (aOk = false), aDetails.push("should have escalated to the buyer");
  if (e.noStockoutThroughDay !== undefined) {
    const ok = trueProj.firstStockoutDay === null || trueProj.firstStockoutDay > e.noStockoutThroughDay;
    if (!ok) (aOk = false), aDetails.push(`with TRUE demand (${e.trueDailyDemand}/day) stock runs out on day ${trueProj.firstStockoutDay} (need none through day ${e.noStockoutThroughDay})`);
    else aDetails.push(`no stockout through day ${e.noStockoutThroughDay} at true demand`);
  }
  if (systemEscalations.length && !e.mustEscalate) (aOk = false), aDetails.push("system had to escalate because the agent could not finish");
  dim("action", aOk ? "PASS" : "FAIL", aDetails);

  // 5. validation — every executed plan was verified, and the run did not end on an unverified state
  const vDetails: string[] = [];
  let vOk = executedPlans.length > 0 && executedPlans.every((p) => p.verification);
  const last = executedPlans.at(-1);
  if (!executedPlans.length) vDetails.push("no plan was executed");
  if (last?.verification && !last.verification.ok && run.status !== "COMPLETED_WITH_ISSUES") (vOk = false), vDetails.push("run ended with failing verification and no escalation");
  const needsExpectation = executedPlans.some((p) => p.plan.actions.some((a) => ["CREATE_PO", "UPDATE_PO_QTY"].includes(a.type)));
  if (needsExpectation && !executedPlans.some((p) => p.plan.expectedOutcome?.noStockoutThroughDay !== undefined)) (vOk = false), vDetails.push("agent never stated a verifiable expected outcome");
  if (vOk) vDetails.push(`${executedPlans.length} executed plan(s) verified; final verification ${last?.verification?.ok ? "passed" : "failed → escalated"}`);
  dim("validation", vOk ? "PASS" : "FAIL", vDetails);

  // 6. recovery
  const deviated = executedPlans.some((p) => p.verification && !p.verification.ok);
  const blocked = run.plans.some((p) => !p.guardrail.ok);
  if (!deviated && !blocked) {
    dim("recovery", e.expectReplan ? "FAIL" : "N/A", [e.expectReplan ? "expected a failed action to recover from, but none occurred (agent may have avoided it — check trace)" : "no failed or blocked action occurred"]);
  } else {
    const recovered = (last?.verification?.ok ?? false) || agentEscalations.length > 0;
    dim("recovery", recovered ? "PASS" : "FAIL", [
      `${blocked ? "plan was blocked by guardrails; " : ""}${deviated ? "execution deviated from expectation; " : ""}${recovered ? "agent recovered (re-planned to a verified state or escalated)" : "agent did not recover"}`,
    ]);
  }

  // 7. explanation
  const text = executedPlans
    .concat(run.plans.filter((p) => !p.execution))
    .map((p) => [p.plan.summary, ...p.plan.keyFactors.map((k) => `${k.factor} ${k.evidence} ${k.impact}`)].join(" "))
    .join(" ")
    .toLowerCase();
  if (!e.rationaleMentions?.length) {
    const ok = (finalPlan?.keyFactors.length ?? 0) > 0;
    dim("explanation", ok ? "PASS" : "FAIL", [ok ? `${finalPlan!.keyFactors.length} key factors given` : "no key factors given"]);
  } else {
    const miss = e.rationaleMentions.filter((g) => !g.some((k) => text.includes(k.toLowerCase())));
    dim("explanation", miss.length || !finalPlan?.keyFactors.length ? "FAIL" : "PASS", miss.length ? miss.map((g) => `rationale never mentions any of: ${g.join(", ")}`) : ["rationale covers the key factor(s)"]);
  }

  const applicable = dims.filter((d) => d.status !== "N/A");
  const passedN = applicable.filter((d) => d.status === "PASS").length;
  return {
    scenarioId: s.id,
    runId: run.id,
    agent: run.agent,
    runStatus: run.status,
    finalDecision,
    newUnits,
    passed: passedN === applicable.length,
    score: Math.round((100 * passedN) / Math.max(1, applicable.length)) / 100,
    dimensions: dims,
    metrics: run.metrics,
  };
}
