/**
 * Guardrails / policy engine.
 *
 * Deterministic checks that run on every plan BEFORE anything is executed.
 *   BLOCK    -> plan is sent back to the agent with the violations (it must revise)
 *   APPROVAL -> plan is valid but high-impact: a human buyer must approve it
 *   INFO     -> surfaced in the trace, no effect
 */
import type { Plan, PlanAction } from "./plan.js";
import { PO_MUTATING } from "./plan.js";
import { projectInventory, type ProjectionOptions } from "./planning.js";
import { OPEN_PO_STATUSES, World } from "./world.js";

export type Severity = "BLOCK" | "APPROVAL" | "INFO";

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  actionIndex?: number;
}

export interface TaskContext {
  sku: string;
  nodeId: string;
  recommendationId?: string;
  poId?: string;
}

export interface PolicyResult {
  ok: boolean; // no BLOCK findings
  requiresApproval: boolean;
  findings: Finding[];
  budgetImpact: number;
  projection: ReturnType<typeof projectInventory>;
}

/** Translate a plan into "what-if" inputs for the projection engine. */
export function planToProjection(world: World, plan: Plan, ctx: TaskContext): ProjectionOptions {
  const extraOrders: NonNullable<ProjectionOptions["extraOrders"]> = [];
  const poQtyOverrides: Record<string, number> = {};
  for (const a of plan.actions) {
    const sku = a.sku ?? ctx.sku;
    const nodeId = a.nodeId ?? ctx.nodeId;
    if (a.type === "CREATE_PO" && a.supplierId && a.quantity && sku === ctx.sku && nodeId === ctx.nodeId) {
      extraOrders.push({ supplierId: a.supplierId, qty: a.quantity, arrivalDay: a.deliveryDay });
    }
    if (a.poId && (a.type === "UPDATE_PO_QTY" || a.type === "ACCEPT_PARTIAL") && a.quantity !== undefined) {
      poQtyOverrides[a.poId] = a.quantity;
    }
    if (a.poId && a.type === "CANCEL_PO") poQtyOverrides[a.poId] = 0;
  }
  return { extraOrders, poQtyOverrides, dailyDemand: plan.demandAssumption?.dailyRate };
}

export function evaluatePlan(world: World, plan: Plan, ctx: TaskContext): PolicyResult {
  const p = world.policy;
  const findings: Finding[] = [];
  const f = (severity: Severity, code: string, message: string, actionIndex?: number) =>
    findings.push({ severity, code, message, actionIndex });

  let budgetImpact = 0;
  const product = world.product(ctx.sku);

  // ---- decision / action consistency -------------------------------------
  const mutating = plan.actions.filter((a) => PO_MUTATING.includes(a.type));
  if (["REJECT", "NO_CHANGE", "INVESTIGATE"].includes(plan.decision) && mutating.some((a) => a.type === "CREATE_PO" || a.type === "UPDATE_PO_QTY")) {
    f("BLOCK", "INCONSISTENT_DECISION", `Decision ${plan.decision} cannot include CREATE_PO/UPDATE_PO_QTY actions.`);
  }
  if (["ACCEPT", "MODIFY"].includes(plan.decision) && ctx.recommendationId && !plan.actions.some((a) => a.type === "CREATE_PO" || a.type === "UPDATE_PO_QTY")) {
    f("BLOCK", "INCONSISTENT_DECISION", `Decision ${plan.decision} on a recommendation must include at least one CREATE_PO or UPDATE_PO_QTY action.`);
  }
  if (plan.decision === "ESCALATE" && !plan.actions.some((a) => a.type === "ESCALATE")) {
    f("BLOCK", "MISSING_ESCALATION", "Decision ESCALATE requires an ESCALATE action with a questionForBuyer.");
  }

  // ---- per-action checks --------------------------------------------------
  plan.actions.forEach((a: PlanAction, i) => {
    const sku = a.sku ?? ctx.sku;
    const nodeId = a.nodeId ?? ctx.nodeId;
    if (a.type === "CREATE_PO") {
      if (!a.supplierId || !a.quantity) return f("BLOCK", "INVALID_ACTION", "CREATE_PO needs supplierId and quantity.", i);
      const offer = world.offer(a.supplierId, sku);
      if (!offer || !offer.active) return f("BLOCK", "NO_ACTIVE_OFFER", `Supplier ${a.supplierId} has no active offer for ${sku}.`, i);
      const s = world.supplier(a.supplierId);
      if (a.quantity < offer.moq) f("BLOCK", "BELOW_MOQ", `Qty ${a.quantity} is below MOQ ${offer.moq} for ${s.name}.`, i);
      if (a.quantity % offer.caseSize !== 0) f("BLOCK", "CASE_SIZE", `Qty ${a.quantity} is not a multiple of case size ${offer.caseSize}.`, i);
      if (a.quantity > offer.availableQty) f("BLOCK", "SUPPLIER_CAPACITY", `${s.name} lists only ${offer.availableQty} units available.`, i);
      if (a.deliveryDay !== undefined && a.deliveryDay < offer.leadTimeDays) f("BLOCK", "LEAD_TIME", `deliveryDay ${a.deliveryDay} is earlier than lead time ${offer.leadTimeDays}d.`, i);
      const value = a.quantity * offer.unitPrice;
      budgetImpact += value;
      if (value > p.autoApproveMaxValue) f("APPROVAL", "HIGH_VALUE_PO", `PO value ${p.currency}${value.toLocaleString()} exceeds auto-approve limit ${p.currency}${p.autoApproveMaxValue.toLocaleString()}.`, i);
      if (s.fillRate < p.minSupplierFillRate) f("APPROVAL", "LOW_RELIABILITY_SUPPLIER", `${s.name} fill rate ${(s.fillRate * 100).toFixed(0)}% is below ${(p.minSupplierFillRate * 100).toFixed(0)}%.`, i);
    }
    if (a.type === "UPDATE_PO_QTY" || a.type === "CANCEL_PO" || a.type === "ACCEPT_PARTIAL") {
      if (!a.poId) return f("BLOCK", "INVALID_ACTION", `${a.type} needs poId.`, i);
      const po = world.state.purchaseOrders.find((x) => x.id === a.poId);
      if (!po) return f("BLOCK", "UNKNOWN_PO", `PO ${a.poId} does not exist.`, i);
      if (!OPEN_PO_STATUSES.has(po.status)) return f("BLOCK", "PO_NOT_OPEN", `PO ${po.id} is ${po.status} and cannot be changed.`, i);
      const current = World.effectiveInboundQty(po);
      if (a.type === "UPDATE_PO_QTY") {
        if (a.quantity === undefined || a.quantity <= 0) return f("BLOCK", "INVALID_ACTION", "UPDATE_PO_QTY needs a positive quantity (use CANCEL_PO to cancel).", i);
        const offer = world.offer(po.supplierId, po.sku);
        if (offer && a.quantity % offer.caseSize !== 0) f("BLOCK", "CASE_SIZE", `Qty ${a.quantity} is not a multiple of case size ${offer.caseSize}.`, i);
        if (offer && a.quantity < offer.moq) f("BLOCK", "BELOW_MOQ", `Qty ${a.quantity} is below MOQ ${offer.moq}.`, i);
        if (po.status === "SUPPLIER_EXCEPTION") f("BLOCK", "PO_IN_EXCEPTION", `PO ${po.id} has an open supplier exception; resolve it with ACCEPT_PARTIAL or CANCEL_PO.`, i);
        const delta = (a.quantity - current) * po.unitPrice;
        budgetImpact += delta;
        if (a.quantity * po.unitPrice > p.autoApproveMaxValue && delta > 0) f("APPROVAL", "HIGH_VALUE_PO", `Updated PO value exceeds auto-approve limit.`, i);
      }
      if (a.type === "ACCEPT_PARTIAL") {
        if (po.status !== "SUPPLIER_EXCEPTION") f("BLOCK", "NO_EXCEPTION", `PO ${po.id} has no supplier exception to accept.`, i);
        const qty = a.quantity ?? po.proposedQty ?? 0;
        if (qty > (po.proposedQty ?? 0)) f("BLOCK", "ABOVE_PROPOSAL", `Supplier only proposed ${po.proposedQty} units.`, i);
        budgetImpact += (qty - current) * po.unitPrice;
      }
      if (a.type === "CANCEL_PO") {
        budgetImpact -= current * po.unitPrice;
        f("APPROVAL", "CANCEL_PO", `Cancelling ${po.id} requires buyer approval.`, i);
      }
    }
    if (a.type === "ESCALATE" && !a.questionForBuyer) {
      f("BLOCK", "INVALID_ACTION", "ESCALATE needs questionForBuyer.", i);
    }
  });

  // ---- budget -------------------------------------------------------------
  const budget = world.budget(product.category);
  const remaining = budget.limit - budget.committed;
  if (budgetImpact > remaining) {
    f("BLOCK", "BUDGET_EXCEEDED", `Plan adds ${p.currency}${budgetImpact.toLocaleString()} but only ${p.currency}${remaining.toLocaleString()} of the ${budget.category} budget remains.`);
  }

  // ---- upsizing vs recommendation ----------------------------------------
  if (ctx.recommendationId) {
    const rec = world.recommendation(ctx.recommendationId);
    const newQty = plan.actions.filter((a) => a.type === "CREATE_PO").reduce((s, a) => s + (a.quantity ?? 0), 0);
    if (newQty > rec.qty * (1 + p.maxDeviationFromRecommendationPct / 100)) {
      f("APPROVAL", "ABOVE_RECOMMENDATION", `Ordering ${newQty} is more than ${p.maxDeviationFromRecommendationPct}% above the recommended ${rec.qty}.`);
    }
  }

  // ---- simulate the plan: storage, overstock, perishability, consistency ---
  const projection = projectInventory(world, ctx.sku, ctx.nodeId, planToProjection(world, plan, ctx));
  if (mutating.length) {
    if (projection.storage.exceedsCapacity) {
      f("BLOCK", "STORAGE_CAPACITY", `Peak stock ${projection.peakStock} exceeds free ${product.storageZone} capacity ${projection.storage.freeCapacityForThisSku} at ${ctx.nodeId}. Consider a smaller qty or a later deliveryDay (split delivery).`);
    }
    if (product.shelfLifeDays && projection.daysOfCoverTotal > product.shelfLifeDays * p.perishableCoverFraction) {
      f("BLOCK", "SHELF_LIFE", `Plan gives ${projection.daysOfCoverTotal} days of cover but shelf life is ${product.shelfLifeDays}d (limit ${Math.floor(product.shelfLifeDays * p.perishableCoverFraction)}d): expected waste.`);
    } else if (projection.daysOfCoverTotal > p.maxDaysOfCover) {
      f("APPROVAL", "OVERSTOCK", `Plan gives ${projection.daysOfCoverTotal} days of cover (> ${p.maxDaysOfCover}d policy max).`);
    }
  }
  const expected = plan.expectedOutcome?.noStockoutThroughDay;
  if (expected !== undefined && projection.firstStockoutDay !== null && projection.firstStockoutDay <= expected) {
    f("BLOCK", "PLAN_INCONSISTENT", `Your own simulation (demand ${projection.demandBasis}) shows a stockout on day ${projection.firstStockoutDay}, but expectedOutcome claims no stockout through day ${expected}. Fix the plan or the expectation.`);
  }
  if (plan.decision !== "ESCALATE" && plan.decision !== "INVESTIGATE" && projection.firstStockoutDay !== null && product.criticality === "high" && !plan.actions.some((a) => a.type === "ESCALATE")) {
    f("INFO", "RESIDUAL_STOCKOUT_RISK", `High-criticality SKU still stocks out on day ${projection.firstStockoutDay} under this plan.`);
  }

  return {
    ok: !findings.some((x) => x.severity === "BLOCK"),
    requiresApproval: findings.some((x) => x.severity === "APPROVAL"),
    findings,
    budgetImpact,
    projection,
  };
}
