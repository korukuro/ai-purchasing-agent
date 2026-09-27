/**
 * The agent's tool surface. Read-only "investigation" tools + deterministic
 * calculators + a single write path (submit_plan) that is handled by the
 * orchestrator, not here. Each tool returns compact JSON the model can reason over.
 */
import type { ToolSpec } from "./llm.js";
import type { Plan } from "../domain/plan.js";
import { evaluatePlan, type TaskContext } from "../domain/policy.js";
import { calculateRequirement, demandSignals, projectInventory } from "../domain/planning.js";
import { World } from "../domain/world.js";
import { searchSop } from "../knowledge/retriever.js";

export interface ToolEnv {
  world: World;
  task: TaskContext;
}

type Handler = (args: Record<string, any>, env: ToolEnv) => unknown;

interface ToolDef extends ToolSpec {
  handler?: Handler; // submit_plan has no handler: the orchestrator owns it
  readOnly: boolean;
}

const str = (description: string) => ({ type: "string", description });
const numb = (description: string) => ({ type: "number", description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });

function summariseProjection(p: ReturnType<typeof projectInventory>) {
  return {
    demandBasis: p.demandBasis,
    startingOnHand: p.startingOnHand,
    firstStockoutDay: p.firstStockoutDay,
    totalLostSales: p.totalLostSales,
    daysOfCoverTotal: p.daysOfCoverTotal,
    peakStock: p.peakStock,
    storage: p.storage,
    arrivals: p.days.filter((d) => d.arrivals > 0).map((d) => ({ day: d.day, units: d.arrivals })),
    closingStockByDay: p.days.slice(0, 14).map((d) => d.closingStock),
  };
}

function poView(world: World, id: string) {
  const po = world.po(id);
  return {
    ...po,
    supplierName: world.supplier(po.supplierId).name,
    effectiveInboundQty: World.effectiveInboundQty(po),
    arrivesInDays: po.expectedArrivalDay - world.today,
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: "get_recommendation",
    description: "Get a purchase recommendation produced by the replenishment system (quantity, supplier, rationale, how it was generated). The recommendation may be wrong or stale.",
    parameters: obj({ recommendationId: str("e.g. REC-1001") }, ["recommendationId"]),
    readOnly: true,
    handler: (a, { world }) => world.recommendation(a.recommendationId),
  },
  {
    name: "get_product",
    description: "Product master data: category (budget bucket), unit cost, storage zone, shelf life, criticality.",
    parameters: obj({ sku: str("SKU code") }, ["sku"]),
    readOnly: true,
    handler: (a, { world }) => world.product(a.sku),
  },
  {
    name: "get_inventory_position",
    description: "Current on-hand stock at a node, storage zone capacity/utilisation, and a summary of all open purchase orders (inbound) for the SKU.",
    parameters: obj({ sku: str("SKU"), nodeId: str("fulfilment node id") }, ["sku", "nodeId"]),
    readOnly: true,
    handler: (a, { world }) => {
      const product = world.product(a.sku);
      const zone = world.node(a.nodeId).zones[product.storageZone];
      const open = world.openPOs(a.sku, a.nodeId);
      return {
        sku: a.sku,
        nodeId: a.nodeId,
        today: world.today,
        onHand: world.inventory(a.sku, a.nodeId).onHand,
        storageZone: product.storageZone,
        zoneCapacityUnits: zone.capacityUnits,
        zoneUsedByOtherProducts: zone.otherProductsUnits,
        freeCapacityForThisSku: zone.capacityUnits - zone.otherProductsUnits,
        openPurchaseOrders: open.map((po) => ({
          id: po.id,
          supplierId: po.supplierId,
          status: po.status,
          qtyOrdered: po.qtyOrdered,
          effectiveInboundQty: World.effectiveInboundQty(po),
          arrivesInDays: po.expectedArrivalDay - world.today,
        })),
        totalInbound: open.reduce((s, po) => s + World.effectiveInboundQty(po), 0),
      };
    },
  },
  {
    name: "get_open_purchase_orders",
    description: "Full details of every open purchase order for a SKU at a node (status, ordered/confirmed qty, arrival day, history).",
    parameters: obj({ sku: str("SKU"), nodeId: str("node id") }, ["sku", "nodeId"]),
    readOnly: true,
    handler: (a, { world }) => world.openPOs(a.sku, a.nodeId).map((po) => poView(world, po.id)),
  },
  {
    name: "get_purchase_order",
    description: "Details of one purchase order by id, including status history and any supplier-proposed quantity.",
    parameters: obj({ poId: str("e.g. PO-3001") }, ["poId"]),
    readOnly: true,
    handler: (a, { world }) => poView(world, a.poId),
  },
  {
    name: "get_supplier_messages",
    description: "Emails / portal messages received from suppliers. Filter by poId or supplierId. Read these to understand exceptions in the supplier's own words.",
    parameters: obj({ poId: str("optional PO id"), supplierId: str("optional supplier id") }),
    readOnly: true,
    handler: (a, { world }) =>
      world.state.supplierMessages.filter(
        (m) => (!a.poId || m.poId === a.poId) && (!a.supplierId || m.supplierId === a.supplierId),
      ),
  },
  {
    name: "get_demand_signals",
    description: "Sales history statistics (3/7/14/28-day averages, trend ratio, outlier days), forecast for the next 14 days, forecast accuracy over the last 14 days, promotions (active/ended/upcoming) and operational notes. Use it to judge whether the forecast can be trusted.",
    parameters: obj({ sku: str("SKU"), nodeId: str("node id") }, ["sku", "nodeId"]),
    readOnly: true,
    handler: (a, { world }) => demandSignals(world, a.sku, a.nodeId),
  },
  {
    name: "get_supplier_options",
    description: "All suppliers offering this SKU with unit price, MOQ, case size, lead time, catalogue-available quantity, and supplier reliability (fill rate, on-time rate, recent incidents).",
    parameters: obj({ sku: str("SKU") }, ["sku"]),
    readOnly: true,
    handler: (a, { world }) =>
      world.offersFor(a.sku).map((o) => {
        const s = world.supplier(o.supplierId);
        return { ...o, supplierName: s.name, fillRate: s.fillRate, onTimeRate: s.onTimeRate, recentIncidents: s.incidents };
      }),
  },
  {
    name: "get_budget",
    description: "Purchasing budget for a category for the current period: limit, committed, remaining.",
    parameters: obj({ category: str("product category, e.g. Staples") }, ["category"]),
    readOnly: true,
    handler: (a, { world }) => {
      const b = world.budget(a.category);
      return { ...b, remaining: b.limit - b.committed, currency: world.policy.currency };
    },
  },
  {
    name: "search_buying_policy",
    description: "Search the buying SOP / policy handbook (approval limits, perishables, supplier exceptions, demand anomalies, budget and storage rules). Returns the most relevant sections.",
    parameters: obj({ query: str("what you want to know") }, ["query"]),
    readOnly: true,
    handler: (a, { world }) => ({ policyParameters: world.policy, sections: searchSop(a.query) }),
  },
  {
    name: "get_decision_history",
    description: "Previous purchasing decisions taken for this SKU (by the agent or buyers). Useful context/memory.",
    parameters: obj({ sku: str("SKU") }, ["sku"]),
    readOnly: true,
    handler: (a, { world }) => world.state.decisionHistory.filter((d) => d.sku === a.sku),
  },
  {
    name: "calculate_requirement",
    description: "Deterministic order-up-to calculation for a SKU/node/supplier: demand over (lead time + review period) + safety stock - on hand - inbound within window, rounded to case size / MOQ. Pass dailyDemand to override the system forecast with your own demand estimate (e.g. recent run-rate).",
    parameters: obj(
      {
        sku: str("SKU"),
        nodeId: str("node id"),
        supplierId: str("supplier whose lead time/MOQ to use"),
        dailyDemand: numb("optional flat daily demand to use instead of the system forecast"),
      },
      ["sku", "nodeId", "supplierId"],
    ),
    readOnly: true,
    handler: (a, { world }) => calculateRequirement(world, a.sku, a.nodeId, a.supplierId, a.dailyDemand),
  },
  {
    name: "simulate_plan",
    description: "What-if simulation BEFORE committing: projects day-by-day stock for the task SKU with hypothetical new orders and/or changes to existing POs, and runs the same policy guardrails that will be applied to your final plan (budget, MOQ, case size, capacity, storage, shelf life, approval thresholds). Use it to test candidate plans.",
    parameters: obj({
      orders: {
        type: "array",
        description: "hypothetical new POs",
        items: obj({ supplierId: str("supplier id"), quantity: numb("units"), deliveryDay: numb("optional scheduled arrival day (>= lead time) for split deliveries") }, ["supplierId", "quantity"]),
      },
      poChanges: {
        type: "array",
        description: "changes to existing POs: newQuantity 0 = cancel; for a SUPPLIER_EXCEPTION PO use acceptPartial=true",
        items: obj({ poId: str("PO id"), newQuantity: numb("units"), acceptPartial: { type: "boolean" } }, ["poId"]),
      },
      dailyDemand: numb("optional flat daily demand instead of the system forecast"),
    }),
    readOnly: true,
    handler: (a, { world, task }) => {
      const plan: Plan = {
        decision: "MODIFY",
        summary: "simulation",
        keyFactors: [],
        confidence: 0.5,
        openQuestions: [],
        demandAssumption: a.dailyDemand !== undefined ? { dailyRate: Number(a.dailyDemand), basis: "" } : undefined,
        actions: [
          ...((a.orders ?? []) as any[]).map((o) => ({
            type: "CREATE_PO" as const,
            reason: "",
            supplierId: o.supplierId,
            quantity: Number(o.quantity),
            deliveryDay: o.deliveryDay !== undefined ? Number(o.deliveryDay) : undefined,
          })),
          ...((a.poChanges ?? []) as any[]).map((c) => ({
            type: c.acceptPartial ? ("ACCEPT_PARTIAL" as const) : Number(c.newQuantity) === 0 ? ("CANCEL_PO" as const) : ("UPDATE_PO_QTY" as const),
            reason: "",
            poId: c.poId,
            quantity: c.newQuantity !== undefined ? Number(c.newQuantity) : undefined,
          })),
        ],
      };
      const res = evaluatePlan(world, plan, task);
      return {
        projection: summariseProjection(res.projection),
        budgetImpact: res.budgetImpact,
        guardrailFindings: res.findings.filter((f) => f.code !== "INCONSISTENT_DECISION"),
        wouldBeBlocked: res.findings.some((f) => f.severity === "BLOCK" && f.code !== "INCONSISTENT_DECISION"),
        wouldNeedApproval: res.requiresApproval,
      };
    },
  },
  {
    name: "submit_plan",
    description:
      "Submit your final decision and the actions to execute. The system validates it against policy guardrails (it may be rejected with violations for you to fix), may route it for buyer approval, executes it against the supplier systems, then VERIFIES the real outcome and returns the result to you. Call this exactly once per decision; if verification reports a problem, submit a follow-up plan containing only the additional actions.",
    parameters: obj(
      {
        decision: { type: "string", enum: ["ACCEPT", "MODIFY", "REJECT", "INVESTIGATE", "ESCALATE", "NO_CHANGE"] },
        summary: str("1-3 sentence explanation of the decision for the buyer"),
        keyFactors: {
          type: "array",
          description: "the important factors behind the decision, each backed by evidence (numbers) from tools",
          items: obj({ factor: str("factor"), evidence: str("specific evidence with numbers"), impact: str("how it affected the decision") }, ["factor", "evidence"]),
        },
        demandAssumption: obj({ dailyRate: numb("daily demand you planned with"), basis: str("why this rate") }, ["dailyRate", "basis"]),
        actions: {
          type: "array",
          description: "actions to execute; empty for pure REJECT / NO_CHANGE",
          items: obj(
            {
              type: { type: "string", enum: ["CREATE_PO", "UPDATE_PO_QTY", "CANCEL_PO", "ACCEPT_PARTIAL", "ESCALATE"] },
              reason: str("why this action"),
              supplierId: str("CREATE_PO: supplier"),
              quantity: numb("CREATE_PO / UPDATE_PO_QTY / ACCEPT_PARTIAL: units"),
              deliveryDay: numb("CREATE_PO optional scheduled arrival day for split deliveries"),
              poId: str("UPDATE_PO_QTY / CANCEL_PO / ACCEPT_PARTIAL: existing PO id"),
              questionForBuyer: str("ESCALATE: the concrete question / options for the human buyer"),
            },
            ["type", "reason"],
          ),
        },
        expectedOutcome: obj({
          noStockoutThroughDay: numb("the plan should prevent any stockout through this day (under your demandAssumption); used to verify the result. Omit it if a stockout is unavoidable (e.g. before any delivery can arrive) and give maxDaysOfCover instead"),
          maxDaysOfCover: numb("upper bound on days of cover you expect"),
          notes: str("anything else you expect"),
        }),
        confidence: numb("0-1"),
        openQuestions: { type: "array", items: { type: "string" } },
      },
      ["decision", "summary", "keyFactors", "demandAssumption", "actions", "confidence"],
    ),
    readOnly: false,
  },
];

export const TOOL_SPECS: ToolSpec[] = TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));

export function runTool(name: string, args: Record<string, unknown>, env: ToolEnv): unknown {
  const t = TOOLS.find((x) => x.name === name);
  if (!t || !t.handler) return { error: `Unknown tool ${name}` };
  try {
    return t.handler(args as Record<string, any>, env);
  } catch (e) {
    return { error: (e as Error).message };
  }
}
