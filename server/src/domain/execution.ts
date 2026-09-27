/**
 * Executor + Verifier.
 *
 * The executor applies an approved plan to the system of record, talking to
 * the (mock) supplier API. The verifier then re-reads the world INDEPENDENTLY
 * (it does not trust the executor's return values) and checks whether the
 * resulting state matches what the agent expected and still satisfies policy.
 */
import type { Plan, PlanAction } from "./plan.js";
import { planToProjection, type TaskContext } from "./policy.js";
import { projectInventory } from "./planning.js";
import { supplierRespond } from "./supplierApi.js";
import type { PurchaseOrder, Recommendation } from "./types.js";
import { World } from "./world.js";

export interface ActionResult {
  actionIndex: number;
  type: PlanAction["type"];
  ok: boolean;
  poId?: string;
  escalationId?: string;
  expected?: { qty: number; arrivalDay: number; unitPrice: number };
  actual?: { qty: number; arrivalDay: number; unitPrice: number; status: string };
  message: string;
}

function adjustBudget(world: World, po: PurchaseOrder, before: number) {
  const b = world.budget(world.product(po.sku).category);
  b.committed = Math.round((b.committed + World.committedValue(po) - before) * 100) / 100;
}

export function executePlan(world: World, plan: Plan, ctx: TaskContext, runId?: string): ActionResult[] {
  const results: ActionResult[] = [];
  const today = world.today;

  plan.actions.forEach((a, i) => {
    const sku = a.sku ?? ctx.sku;
    const nodeId = a.nodeId ?? ctx.nodeId;
    try {
      if (a.type === "CREATE_PO") {
        const offer = world.offer(a.supplierId!, sku)!;
        const po: PurchaseOrder = {
          id: world.nextId("PO"),
          supplierId: a.supplierId!,
          sku,
          nodeId,
          qtyOrdered: a.quantity!,
          qtyConfirmed: null,
          unitPrice: offer.unitPrice,
          status: "SUBMITTED",
          createdDay: today,
          expectedArrivalDay: today + (a.deliveryDay ?? offer.leadTimeDays),
          createdBy: "agent",
          history: [{ day: today, event: `created by agent${runId ? ` (run ${runId})` : ""}: ${a.reason}` }],
        };
        world.state.purchaseOrders.push(po);
        const expected = { qty: po.qtyOrdered, arrivalDay: po.expectedArrivalDay, unitPrice: po.unitPrice };
        const r = supplierRespond(world, po, po.qtyOrdered);
        po.status = r.status;
        po.qtyConfirmed = r.qtyConfirmed;
        po.expectedArrivalDay = r.expectedArrivalDay;
        po.unitPrice = r.unitPrice;
        po.history.push({ day: today, event: r.message });
        adjustBudget(world, po, 0); // commit only what the supplier confirmed
        results.push({
          actionIndex: i,
          type: a.type,
          ok: r.status !== "REJECTED_BY_SUPPLIER",
          poId: po.id,
          expected,
          actual: { qty: r.qtyConfirmed, arrivalDay: r.expectedArrivalDay, unitPrice: r.unitPrice, status: r.status },
          message: r.message,
        });
      } else if (a.type === "UPDATE_PO_QTY") {
        const po = world.po(a.poId!);
        const before = World.committedValue(po);
        const current = World.effectiveInboundQty(po);
        const expected = { qty: a.quantity!, arrivalDay: po.expectedArrivalDay, unitPrice: po.unitPrice };
        let message: string;
        if (a.quantity! <= current) {
          po.qtyOrdered = a.quantity!;
          po.qtyConfirmed = a.quantity!;
          message = `Supplier accepted reduction of ${po.id} to ${a.quantity}.`;
        } else {
          const r = supplierRespond(world, po, a.quantity!);
          po.qtyOrdered = a.quantity!;
          po.qtyConfirmed = Math.max(current, r.qtyConfirmed);
          po.status = po.qtyConfirmed < a.quantity! ? "PARTIALLY_CONFIRMED" : "CONFIRMED";
          po.expectedArrivalDay = r.expectedArrivalDay;
          po.unitPrice = r.unitPrice;
          message = r.message;
        }
        po.history.push({ day: today, event: `qty changed by agent to ${a.quantity}: ${message}` });
        adjustBudget(world, po, before);
        results.push({
          actionIndex: i,
          type: a.type,
          ok: true,
          poId: po.id,
          expected,
          actual: { qty: World.effectiveInboundQty(po), arrivalDay: po.expectedArrivalDay, unitPrice: po.unitPrice, status: po.status },
          message,
        });
      } else if (a.type === "CANCEL_PO") {
        const po = world.po(a.poId!);
        const before = World.committedValue(po);
        po.status = "CANCELLED";
        po.history.push({ day: today, event: `cancelled by agent: ${a.reason}` });
        adjustBudget(world, po, before);
        results.push({ actionIndex: i, type: a.type, ok: true, poId: po.id, message: `${po.id} cancelled.` });
      } else if (a.type === "ACCEPT_PARTIAL") {
        const po = world.po(a.poId!);
        const before = World.committedValue(po);
        const qty = a.quantity ?? po.proposedQty ?? 0;
        po.status = "PARTIALLY_CONFIRMED";
        po.qtyConfirmed = qty;
        po.proposedQty = null;
        po.history.push({ day: today, event: `agent accepted partial quantity ${qty}; remainder cancelled` });
        adjustBudget(world, po, before);
        results.push({
          actionIndex: i,
          type: a.type,
          ok: true,
          poId: po.id,
          expected: { qty, arrivalDay: po.expectedArrivalDay, unitPrice: po.unitPrice },
          actual: { qty: po.qtyConfirmed, arrivalDay: po.expectedArrivalDay, unitPrice: po.unitPrice, status: po.status },
          message: `${po.id} now ${qty} units (remainder cancelled).`,
        });
      } else if (a.type === "ESCALATE") {
        const id = world.nextId("ESC");
        world.state.escalations.push({
          id,
          kind: plan.decision === "INVESTIGATE" ? "INVESTIGATION" : "ESCALATION",
          sku,
          nodeId,
          reason: a.reason,
          questionForBuyer: a.questionForBuyer ?? "",
          createdDay: today,
          runId,
        });
        results.push({ actionIndex: i, type: a.type, ok: true, escalationId: id, message: `Escalation ${id} raised to buyer.` });
      }
    } catch (e) {
      results.push({ actionIndex: i, type: a.type, ok: false, message: `Execution error: ${(e as Error).message}` });
    }
  });

  // Close the loop on the recommendation (if this task came from one)
  if (ctx.recommendationId) {
    const rec = world.recommendation(ctx.recommendationId);
    const statusByDecision: Record<Plan["decision"], Recommendation["status"]> = {
      ACCEPT: "ACCEPTED",
      MODIFY: "MODIFIED",
      REJECT: "REJECTED",
      INVESTIGATE: "UNDER_INVESTIGATION",
      ESCALATE: "ESCALATED",
      NO_CHANGE: "REJECTED",
    };
    rec.status = statusByDecision[plan.decision];
    rec.resolvedQty = plan.actions.filter((a) => a.type === "CREATE_PO").reduce((s, a) => s + (a.quantity ?? 0), 0);
  }
  world.state.decisionHistory.push({ day: today, sku: ctx.sku, decision: plan.decision, summary: plan.summary });
  return results;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerificationResult {
  ok: boolean;
  checks: VerificationCheck[];
  projection: ReturnType<typeof projectInventory>;
}

export function verifyOutcome(world: World, plan: Plan, ctx: TaskContext, results: ActionResult[]): VerificationResult {
  const checks: VerificationCheck[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });

  // 1. Did every action land in the system of record the way the agent expected?
  for (const r of results) {
    if (!r.ok) {
      add(`action#${r.actionIndex} ${r.type}`, false, r.message);
      continue;
    }
    if (r.poId && r.expected) {
      const po = world.po(r.poId); // independent read-back
      const got = World.effectiveInboundQty(po);
      add(`${r.poId} quantity`, got === r.expected.qty, `expected ${r.expected.qty}, system of record shows ${got} (${po.status})`);
      add(`${r.poId} arrival`, po.expectedArrivalDay <= r.expected.arrivalDay, `expected day ${r.expected.arrivalDay}, now day ${po.expectedArrivalDay}`);
      add(`${r.poId} price`, po.unitPrice <= r.expected.unitPrice, `expected ${r.expected.unitPrice}, now ${po.unitPrice}`);
    }
    if (r.escalationId) {
      add(`escalation ${r.escalationId}`, world.state.escalations.some((e) => e.id === r.escalationId), "escalation ticket exists in buyer inbox");
    }
  }

  // 2. Constraints still hold on the resulting state
  const product = world.product(ctx.sku);
  const budget = world.budget(product.category);
  add("budget", budget.committed <= budget.limit, `committed ${budget.committed.toLocaleString()} / limit ${budget.limit.toLocaleString()}`);

  // Project with the *actual* state (no hypothetical overrides) under the agent's demand assumption
  const opts = planToProjection(world, plan, ctx);
  const projection = projectInventory(world, ctx.sku, ctx.nodeId, { dailyDemand: opts.dailyDemand });
  add("storage", !projection.storage.exceedsCapacity, `peak ${projection.peakStock} vs free capacity ${projection.storage.freeCapacityForThisSku}`);

  // 3. Does the outcome meet the agent's own stated expectation?
  const through = plan.expectedOutcome?.noStockoutThroughDay;
  if (through !== undefined) {
    const ok = projection.firstStockoutDay === null || projection.firstStockoutDay > through;
    add("no stockout (expected outcome)", ok, projection.firstStockoutDay === null ? `no stockout within ${world.policy.planningHorizonDays}d horizon` : `stockout on day ${projection.firstStockoutDay}, expected none through day ${through}`);
  }
  const maxCover = plan.expectedOutcome?.maxDaysOfCover;
  if (maxCover !== undefined) {
    add("days of cover (expected outcome)", projection.daysOfCoverTotal <= maxCover * 1.1, `${projection.daysOfCoverTotal} days of cover vs expected max ${maxCover}`);
  }
  if (product.shelfLifeDays) {
    const lim = product.shelfLifeDays * world.policy.perishableCoverFraction;
    add("shelf life", projection.daysOfCoverTotal <= lim || !results.some((r) => r.type === "CREATE_PO"), `${projection.daysOfCoverTotal} days of cover vs ${lim}d perishability limit`);
  }

  return { ok: checks.every((c) => c.passed), checks, projection };
}
