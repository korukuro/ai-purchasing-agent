/**
 * Test scenarios. Each one is a complete, isolated world + a trigger + the
 * ground-truth expectations the evaluator grades against.
 */
import type { Product, WorldState } from "../domain/types.js";
import { baseWorld, flat, NODE, series } from "./builders.js";
import type { Scenario } from "./types.js";

const N = NODE.id;
const H = 28; // days of sales history

// get_situation_overview returns all of these in one call, so it satisfies every group.
const OV = "get_situation_overview";
const EVIDENCE = {
  stock: { anyOf: [OV, "get_inventory_position", "calculate_requirement", "simulate_plan"], why: "current on-hand stock" },
  openPOs: { anyOf: [OV, "get_open_purchase_orders", "get_inventory_position"], why: "existing open purchase orders" },
  demand: { anyOf: [OV, "get_demand_signals"], why: "actual sales vs forecast" },
  suppliers: { anyOf: [OV, "get_supplier_options"], why: "supplier MOQ / lead time / alternates" },
  budget: { anyOf: [OV, "get_budget"], why: "remaining purchasing budget" },
  supplierMsg: { anyOf: [OV, "get_supplier_messages", "get_purchase_order"], why: "what the supplier actually said" },
};

function product(p: Partial<Product> & Pick<Product, "sku" | "name" | "category" | "unitCost">): Product {
  return { storageZone: "ambient", shelfLifeDays: null, criticality: "normal", ...p };
}

function withSku(
  w: WorldState,
  p: Product,
  onHand: number,
  salesHistory: number[],
  pastForecast: number[],
  forecast: number[],
  notes?: string[],
) {
  w.products.push(p);
  w.inventory.push({ sku: p.sku, nodeId: N, onHand });
  w.demand.push({ sku: p.sku, nodeId: N, salesHistory, pastForecast, forecast, notes });
  return w;
}

// ---------------------------------------------------------------------------
// Scenario 1 — Purchase recommendation review (800 units)
// ---------------------------------------------------------------------------

function s1Accept(): Scenario {
  const w = baseWorld();
  const p = product({ sku: "NOODLE-4PK", name: "Instant Noodles 4-pack", category: "Packaged Food", unitCost: 48, shelfLifeDays: 180 });
  withSku(w, p, 150, series(H, 70), flat(H, 70), flat(42, 70));
  w.offers.push(
    { supplierId: "SUP-FRESHFIELDS", sku: p.sku, unitPrice: 48, moq: 240, caseSize: 20, leadTimeDays: 3, availableQty: 5000, active: true },
    { supplierId: "SUP-BUDGET", sku: p.sku, unitPrice: 44, moq: 400, caseSize: 20, leadTimeDays: 7, availableQty: 5000, active: true },
  );
  w.budgets.push({ category: "Packaged Food", periodLabel: "Sep-2026", limit: 500_000, committed: 210_000 });
  w.recommendations.push({ id: "REC-1001", sku: p.sku, nodeId: N, supplierId: "SUP-FRESHFIELDS", qty: 800, generatedBy: "replenishment-engine v3 (nightly batch)", rationale: "Order-up-to level from 14-day forecast (70/day) incl. safety stock; rounded to case pack.", status: "OPEN" });
  return {
    id: "s1-accept",
    assignmentScenario: 1,
    title: "Recommendation is sound → accept",
    description: "The system recommends 800 units of instant noodles. Stock is low, there are no open POs, demand is stable, budget and storage are fine. The independently computed need (~760) is within 10% of the recommendation.",
    trigger: { kind: "RECOMMENDATION_REVIEW", message: "Review purchase recommendation REC-1001: buy 800 units of NOODLE-4PK for DS-BLR-01 from SUP-FRESHFIELDS.", context: { sku: p.sku, nodeId: N, recommendationId: "REC-1001" } },
    world: w,
    expectations: {
      allowedDecisions: ["ACCEPT", "MODIFY"],
      requiredEvidence: [EVIDENCE.stock, EVIDENCE.openPOs, EVIDENCE.demand, EVIDENCE.budget],
      newUnitsRange: [720, 880],
      trueDailyDemand: 70,
      noStockoutThroughDay: 10,
      requiredActionTypes: ["CREATE_PO"],
    },
  };
}

function s1OpenPO(): Scenario {
  const w = baseWorld();
  const p = product({ sku: "COFFEE-100G", name: "Instant Coffee 100g", category: "Beverages", unitCost: 210, shelfLifeDays: 365 });
  withSku(w, p, 120, series(H, 50, 0.1, 1), flat(H, 50), flat(42, 50));
  w.offers.push({ supplierId: "SUP-METRO", sku: p.sku, unitPrice: 210, moq: 60, caseSize: 12, leadTimeDays: 4, availableQty: 3000, active: true });
  w.purchaseOrders.push({ id: "PO-2001", supplierId: "SUP-METRO", sku: p.sku, nodeId: N, qtyOrdered: 400, qtyConfirmed: 400, unitPrice: 210, status: "CONFIRMED", createdDay: -2, expectedArrivalDay: 2, createdBy: "buyer", history: [{ day: -2, event: "created by buyer (manual top-up)" }, { day: -2, event: "confirmed by Metro Wholesale" }] });
  w.budgets.push({ category: "Beverages", periodLabel: "Sep-2026", limit: 600_000, committed: 250_000 });
  w.recommendations.push({ id: "REC-1002", sku: p.sku, nodeId: N, supplierId: "SUP-METRO", qty: 800, generatedBy: "replenishment-engine v3 (nightly batch, inventory snapshot D-3 23:00)", rationale: "14-day forecast demand 700 + safety stock 100, less on-hand.", status: "OPEN" });
  return {
    id: "s1-open-po",
    assignmentScenario: 1,
    title: "Recommendation ignores an open PO → modify down",
    description: "Recommendation of 800 was computed from a stale snapshot that predates a confirmed 400-unit PO arriving in 2 days. The real need is ~180 units.",
    trigger: { kind: "RECOMMENDATION_REVIEW", message: "Review purchase recommendation REC-1002: buy 800 units of COFFEE-100G for DS-BLR-01 from SUP-METRO.", context: { sku: p.sku, nodeId: N, recommendationId: "REC-1002" } },
    world: w,
    expectations: {
      allowedDecisions: ["MODIFY"],
      requiredEvidence: [EVIDENCE.stock, EVIDENCE.openPOs, EVIDENCE.demand],
      newUnitsRange: [120, 300],
      trueDailyDemand: 50,
      noStockoutThroughDay: 11,
      requiredActionTypes: ["CREATE_PO"],
      rationaleMentions: [["PO-2001", "open po", "open purchase order", "inbound", "incoming"]],
    },
  };
}

function s1Reject(): Scenario {
  const w = baseWorld();
  const p = product({ sku: "YOGURT-400G", name: "Greek Yogurt 400g", category: "Dairy", unitCost: 65, storageZone: "chilled", shelfLifeDays: 12 });
  withSku(w, p, 520, series(H, 35, 0.1, 2), flat(H, 35), flat(42, 35));
  w.offers.push({ supplierId: "SUP-DAIRY", sku: p.sku, unitPrice: 65, moq: 100, caseSize: 20, leadTimeDays: 2, availableQty: 2000, active: true });
  w.purchaseOrders.push({ id: "PO-2101", supplierId: "SUP-DAIRY", sku: p.sku, nodeId: N, qtyOrdered: 200, qtyConfirmed: 200, unitPrice: 65, status: "CONFIRMED", createdDay: -1, expectedArrivalDay: 3, createdBy: "system", history: [{ day: -1, event: "auto-replenishment PO confirmed" }] });
  w.budgets.push({ category: "Dairy", periodLabel: "Sep-2026", limit: 300_000, committed: 90_000 });
  w.recommendations.push({ id: "REC-1003", sku: p.sku, nodeId: N, supplierId: "SUP-DAIRY", qty: 800, generatedBy: "replenishment-engine v3 (nightly batch)", rationale: "Weekend promotion uplift expected (+40%).", status: "OPEN" });
  return {
    id: "s1-reject",
    assignmentScenario: 1,
    title: "Perishable already overstocked → reject",
    description: "800 units of a 12-day shelf-life yogurt is recommended citing a promotion that does not exist in the promo calendar. Stock + inbound already cover ~20 days (limit ~8). Buying would cause write-offs and overflow chilled storage.",
    trigger: { kind: "RECOMMENDATION_REVIEW", message: "Review purchase recommendation REC-1003: buy 800 units of YOGURT-400G for DS-BLR-01 from SUP-DAIRY.", context: { sku: p.sku, nodeId: N, recommendationId: "REC-1003" } },
    world: w,
    expectations: {
      allowedDecisions: ["REJECT"],
      requiredEvidence: [EVIDENCE.stock, EVIDENCE.openPOs, EVIDENCE.demand],
      newUnitsRange: [0, 0],
      trueDailyDemand: 35,
      noStockoutThroughDay: 14,
      rationaleMentions: [["shelf", "perish", "expir", "waste", "write-off", "overstock", "days of cover"]],
    },
  };
}

function s1Anomaly(): Scenario {
  const w = baseWorld();
  const p = product({ sku: "DETERGENT-1KG", name: "Detergent Powder 1kg", category: "Home Care", unitCost: 180 });
  const hist = series(H, 30, 0.1, 3);
  hist[H - 4] = 930; // one-off institutional order
  const pastFc = [...flat(H - 3, 30), 90, 90, 90];
  withSku(w, p, 400, hist, pastFc, flat(42, 90), ["D-4: order channel mix included B2B / institutional orders (pilot)."]);
  w.offers.push({ supplierId: "SUP-FRESHFIELDS", sku: p.sku, unitPrice: 180, moq: 50, caseSize: 10, leadTimeDays: 3, availableQty: 4000, active: true });
  w.budgets.push({ category: "Home Care", periodLabel: "Sep-2026", limit: 400_000, committed: 150_000 });
  w.recommendations.push({ id: "REC-1004", sku: p.sku, nodeId: N, supplierId: "SUP-FRESHFIELDS", qty: 800, generatedBy: "replenishment-engine v3 (nightly batch)", rationale: "Forecast raised to 90/day after recent demand surge.", status: "OPEN" });
  return {
    id: "s1-forecast-anomaly",
    assignmentScenario: 1,
    title: "Forecast inflated by a one-off bulk order → investigate",
    description: "A single 930-unit day (institutional order) pushed the forecast from 30/day to 90/day, and the recommendation follows it. Normal demand is ~30/day and current stock covers ~13 days, so the agent should not buy and should flag the forecast.",
    trigger: { kind: "RECOMMENDATION_REVIEW", message: "Review purchase recommendation REC-1004: buy 800 units of DETERGENT-1KG for DS-BLR-01 from SUP-FRESHFIELDS.", context: { sku: p.sku, nodeId: N, recommendationId: "REC-1004" } },
    world: w,
    expectations: {
      allowedDecisions: ["INVESTIGATE", "ESCALATE", "REJECT"],
      requiredEvidence: [EVIDENCE.stock, EVIDENCE.demand],
      newUnitsRange: [0, 120],
      trueDailyDemand: 30,
      noStockoutThroughDay: 12,
      rationaleMentions: [["outlier", "one-off", "one off", "bulk", "b2b", "institutional", "anomal", "single day", "spike"]],
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 2 — Supplier cannot fulfil (500 ordered, 250 possible)
// ---------------------------------------------------------------------------

function oilWorld(sku: string, name: string) {
  const w = baseWorld();
  const p = product({ sku, name, category: "Staples", unitCost: 125, shelfLifeDays: 270, criticality: "high" });
  withSku(w, p, 90, series(H, 45, 0.08, 4), flat(H, 45), flat(42, 45));
  w.purchaseOrders.push({ id: "PO-3001", supplierId: "SUP-FRESHFIELDS", sku, nodeId: N, qtyOrdered: 500, qtyConfirmed: null, proposedQty: 250, unitPrice: 125, status: "SUPPLIER_EXCEPTION", createdDay: -3, expectedArrivalDay: 2, createdBy: "system", history: [{ day: -3, event: "created by replenishment engine" }, { day: 0, event: "supplier exception: can only supply 250" }] });
  w.supplierMessages.push({ id: "MSG-9001", supplierId: "SUP-FRESHFIELDS", poId: "PO-3001", receivedDay: 0, channel: "email", subject: "RE: PO-3001 – supply constraint", body: "Hi team, due to a shortage at our refinery partner we can only dispatch 250 units against PO-3001 on the planned date (day 2). We cannot commit to the balance 250 units – earliest would be ~3 weeks and even that is not guaranteed. Please confirm if we should proceed with 250. Regards, FreshFields Order Desk" });
  w.offers.push({ supplierId: "SUP-FRESHFIELDS", sku, unitPrice: 125, moq: 100, caseSize: 25, leadTimeDays: 2, availableQty: 0, active: true });
  w.budgets.push({ category: "Staples", periodLabel: "Sep-2026", limit: 800_000, committed: 331_250 });
  return { w, p };
}

function s2Alternate(): Scenario {
  const { w, p } = oilWorld("OIL-SUNFLOWER-1L", "Sunflower Oil 1L");
  w.offers.push(
    { supplierId: "SUP-METRO", sku: p.sku, unitPrice: 132, moq: 100, caseSize: 20, leadTimeDays: 2, availableQty: 800, active: true },
    { supplierId: "SUP-BUDGET", sku: p.sku, unitPrice: 118, moq: 200, caseSize: 20, leadTimeDays: 8, availableQty: 2000, active: true },
  );
  return {
    id: "s2-alternate-supplier",
    assignmentScenario: 2,
    title: "Partial fulfilment → accept 250 + source the gap elsewhere",
    description: "PO-3001 for 500 units can only be filled 250. With 90 on hand and 45/day demand, 250 only lasts until ~day 7. A reliable alternate (Metro, 2-day lead time, slightly pricier) can cover the gap; a cheaper one (BudgetMart) arrives too late and is unreliable.",
    trigger: { kind: "SUPPLIER_EXCEPTION", message: "Supplier exception on PO-3001 (OIL-SUNFLOWER-1L, DS-BLR-01): ordered 500, supplier says only 250 can be supplied. Decide what should happen next.", context: { sku: p.sku, nodeId: N, poId: "PO-3001" } },
    world: w,
    expectations: {
      allowedDecisions: ["MODIFY", "ACCEPT"],
      requiredEvidence: [EVIDENCE.supplierMsg, EVIDENCE.stock, EVIDENCE.demand, EVIDENCE.suppliers],
      newUnitsRange: [180, 450],
      trueDailyDemand: 45,
      noStockoutThroughDay: 10,
      requiredActionTypes: ["ACCEPT_PARTIAL", "CREATE_PO"],
      rationaleMentions: [["stockout", "stock-out", "stock out", "run out", "cover"]],
    },
  };
}

function s2Sufficient(): Scenario {
  const w = baseWorld();
  const p = product({ sku: "DISHWASH-500ML", name: "Dishwash Liquid 500ml", category: "Home Care", unitCost: 95 });
  withSku(w, p, 600, series(H, 25, 0.1, 5), flat(H, 25), flat(42, 25));
  w.purchaseOrders.push({ id: "PO-3101", supplierId: "SUP-QUICK", sku: p.sku, nodeId: N, qtyOrdered: 500, qtyConfirmed: null, proposedQty: 250, unitPrice: 95, status: "SUPPLIER_EXCEPTION", createdDay: -2, expectedArrivalDay: 3, createdBy: "system", history: [{ day: 0, event: "supplier exception: can only supply 250" }] });
  w.supplierMessages.push({ id: "MSG-9101", supplierId: "SUP-QUICK", poId: "PO-3101", receivedDay: 0, channel: "portal", subject: "PO-3101 short supply", body: "Only 250 of 500 units available for PO-3101 due to packaging material delay. Can ship 250 on schedule. Balance not available this month." });
  w.offers.push(
    { supplierId: "SUP-QUICK", sku: p.sku, unitPrice: 95, moq: 100, caseSize: 25, leadTimeDays: 3, availableQty: 0, active: true },
    { supplierId: "SUP-METRO", sku: p.sku, unitPrice: 99, moq: 100, caseSize: 20, leadTimeDays: 2, availableQty: 1500, active: true },
  );
  w.budgets.push({ category: "Home Care", periodLabel: "Sep-2026", limit: 400_000, committed: 180_000 });
  return {
    id: "s2-inventory-sufficient",
    assignmentScenario: 2,
    title: "Partial fulfilment, but stock is sufficient → accept partial only",
    description: "Supplier can only ship 250 of 500. With 600 on hand and 25/day demand, stock + 250 covers ~34 days. No need to buy elsewhere (an alternate exists and would be tempting).",
    trigger: { kind: "SUPPLIER_EXCEPTION", message: "Supplier exception on PO-3101 (DISHWASH-500ML, DS-BLR-01): ordered 500, supplier says only 250 can be supplied. Decide what should happen next.", context: { sku: p.sku, nodeId: N, poId: "PO-3101" } },
    world: w,
    expectations: {
      allowedDecisions: ["ACCEPT", "MODIFY", "NO_CHANGE"],
      requiredEvidence: [EVIDENCE.supplierMsg, EVIDENCE.stock, EVIDENCE.demand],
      newUnitsRange: [0, 0],
      trueDailyDemand: 25,
      noStockoutThroughDay: 21,
      requiredActionTypes: ["ACCEPT_PARTIAL"],
    },
  };
}

function s2Escalate(): Scenario {
  const w = baseWorld();
  const p = product({ sku: "FORMULA-400G", name: "Infant Formula Stage 1 400g", category: "Baby Care", unitCost: 620, shelfLifeDays: 365, criticality: "high" });
  withSku(w, p, 30, series(H, 12, 0.1, 6), flat(H, 12), flat(42, 12));
  w.purchaseOrders.push({ id: "PO-3201", supplierId: "SUP-FRESHFIELDS", sku: p.sku, nodeId: N, qtyOrdered: 200, qtyConfirmed: null, proposedQty: 60, unitPrice: 620, status: "SUPPLIER_EXCEPTION", createdDay: -3, expectedArrivalDay: 2, createdBy: "system", history: [{ day: 0, event: "supplier exception: can only supply 60" }] });
  w.supplierMessages.push({ id: "MSG-9201", supplierId: "SUP-FRESHFIELDS", poId: "PO-3201", receivedDay: 0, channel: "email", subject: "PO-3201 allocation", body: "Manufacturer has put this SKU on allocation. We can supply 60 units on day 2; no further stock expected for at least 4 weeks." });
  w.offers.push(
    { supplierId: "SUP-FRESHFIELDS", sku: p.sku, unitPrice: 620, moq: 24, caseSize: 12, leadTimeDays: 2, availableQty: 0, active: true },
    { supplierId: "SUP-BUDGET", sku: p.sku, unitPrice: 655, moq: 48, caseSize: 12, leadTimeDays: 12, availableQty: 300, active: true },
  );
  w.budgets.push({ category: "Baby Care", periodLabel: "Sep-2026", limit: 500_000, committed: 200_000 });
  return {
    id: "s2-no-good-alternative",
    assignmentScenario: 2,
    title: "Partial fulfilment, no alternate can arrive in time → escalate",
    description: "High-criticality infant formula on manufacturer allocation: only 60 of 200 units. Stock runs out ~day 7. The only alternate supplier has a 12-day lead time and 72% fill rate, so a stockout gap is unavoidable. The agent should secure the 60 units and escalate with options (e.g. inter-store transfer, customer purchase limits).",
    trigger: { kind: "SUPPLIER_EXCEPTION", message: "Supplier exception on PO-3201 (FORMULA-400G, DS-BLR-01): ordered 200, supplier says only 60 can be supplied. Decide what should happen next.", context: { sku: p.sku, nodeId: N, poId: "PO-3201" } },
    world: w,
    expectations: {
      allowedDecisions: ["ESCALATE", "MODIFY"],
      requiredEvidence: [EVIDENCE.supplierMsg, EVIDENCE.stock, EVIDENCE.suppliers],
      newUnitsRange: [0, 400],
      trueDailyDemand: 12,
      requiredActionTypes: ["ACCEPT_PARTIAL", "ESCALATE"],
      mustEscalate: true,
    },
  };
}

function s2FeedbackLoop(): Scenario {
  const { w, p } = oilWorld("OIL-MUSTARD-1L", "Mustard Oil 1L");
  w.offers.push(
    { supplierId: "SUP-METRO", sku: p.sku, unitPrice: 130, moq: 100, caseSize: 20, leadTimeDays: 2, availableQty: 800, active: true },
    { supplierId: "SUP-QUICK", sku: p.sku, unitPrice: 145, moq: 60, caseSize: 20, leadTimeDays: 3, availableQty: 600, active: true },
  );
  // The catalogue says Metro has 800 available, but in reality it can only confirm 100.
  w.supplierBehavior[`SUP-METRO:${p.sku}`] = { maxConfirmQty: 100 };
  return {
    id: "s2-feedback-loop",
    assignmentScenario: 2,
    title: "Alternate supplier also under-delivers → detect & re-plan",
    description: "Same as the partial-fulfilment case, but the alternate (Metro) only confirms 100 units despite its catalogue showing 800. Verification must catch the shortfall and the agent must re-plan (e.g. top up from QuickSupply) or escalate.",
    trigger: { kind: "SUPPLIER_EXCEPTION", message: "Supplier exception on PO-3001 (OIL-MUSTARD-1L, DS-BLR-01): ordered 500, supplier says only 250 can be supplied. Decide what should happen next.", context: { sku: p.sku, nodeId: N, poId: "PO-3001" } },
    world: w,
    expectations: {
      allowedDecisions: ["MODIFY", "ACCEPT", "ESCALATE"],
      requiredEvidence: [EVIDENCE.supplierMsg, EVIDENCE.stock, EVIDENCE.suppliers],
      newUnitsRange: [180, 450],
      trueDailyDemand: 45,
      noStockoutThroughDay: 10,
      requiredActionTypes: ["ACCEPT_PARTIAL", "CREATE_PO"],
      expectReplan: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 3 — Demand has changed
// ---------------------------------------------------------------------------

function s3Spike(): Scenario {
  const w = baseWorld();
  const p = product({ sku: "ELECTROLYTE-500ML", name: "Electrolyte Drink 500ml", category: "Beverages", unitCost: 35, shelfLifeDays: 270 });
  const hist = [...series(18, 40, 0.08, 7), 52, 58, 66, 74, 82, 86, 90, 94, 92, 96];
  withSku(w, p, 300, hist, flat(H, 40), flat(42, 40), ["Weather: heatwave advisory for Bangalore issued D-10, expected to last ~2 more weeks."]);
  w.offers.push({ supplierId: "SUP-METRO", sku: p.sku, unitPrice: 35, moq: 120, caseSize: 20, leadTimeDays: 3, availableQty: 3000, active: true });
  w.purchaseOrders.push({ id: "PO-4001", supplierId: "SUP-METRO", sku: p.sku, nodeId: N, qtyOrdered: 400, qtyConfirmed: 400, unitPrice: 35, status: "CONFIRMED", createdDay: -1, expectedArrivalDay: 3, createdBy: "system", history: [{ day: -1, event: "replenishment PO confirmed" }] });
  w.budgets.push({ category: "Beverages", periodLabel: "Sep-2026", limit: 600_000, committed: 250_000 });
  return {
    id: "s3-sustained-spike",
    assignmentScenario: 3,
    title: "Sustained demand increase → re-plan with higher run-rate",
    description: "Sales have climbed for 10 straight days to ~90/day (heatwave) while the forecast still says 40. Stock + the 400-unit open PO run out around day 7. The agent should re-plan on the recent run-rate and top up (increase the PO or add one).",
    trigger: { kind: "DEMAND_ALERT", message: "Demand alert: ELECTROLYTE-500ML at DS-BLR-01 has sold ~2.2x forecast over the last 7 days. There is an existing open PO. Check whether the purchasing plan needs to change.", context: { sku: p.sku, nodeId: N } },
    world: w,
    expectations: {
      allowedDecisions: ["MODIFY"],
      requiredEvidence: [EVIDENCE.demand, EVIDENCE.stock, EVIDENCE.openPOs],
      newUnitsRange: [360, 1100],
      trueDailyDemand: 90,
      noStockoutThroughDay: 10,
      rationaleMentions: [["trend", "sustain", "consecutive", "heatwave", "run-rate", "run rate", "7-day", "last 7"]],
    },
  };
}

function s3FalseSpike(): Scenario {
  const w = baseWorld();
  const p = product({ sku: "CHOCO-BAR-50G", name: "Chocolate Bar 50g", category: "Snacks", unitCost: 40, shelfLifeDays: 240 });
  const hist = [...series(21, 50, 0.08, 8), 120, 128, 131, 125, 119, 127, 124];
  withSku(w, p, 350, hist, [...flat(21, 50), ...flat(7, 125)], flat(42, 50));
  w.promotions.push({ sku: p.sku, name: "Weekend Treats – buy 2 get 1", startDay: -7, endDay: -1, upliftPct: 150 });
  w.offers.push({ supplierId: "SUP-FRESHFIELDS", sku: p.sku, unitPrice: 40, moq: 100, caseSize: 20, leadTimeDays: 3, availableQty: 5000, active: true });
  w.purchaseOrders.push({ id: "PO-4101", supplierId: "SUP-FRESHFIELDS", sku: p.sku, nodeId: N, qtyOrdered: 300, qtyConfirmed: 300, unitPrice: 40, status: "CONFIRMED", createdDay: -2, expectedArrivalDay: 2, createdBy: "system", history: [] });
  w.budgets.push({ category: "Snacks", periodLabel: "Sep-2026", limit: 300_000, committed: 120_000 });
  return {
    id: "s3-promo-spike",
    assignmentScenario: 3,
    title: "Spike explained by an ended promotion → no change",
    description: "Sales ran ~2.5x for 7 days, but a buy-2-get-1 promotion explains it and it ended yesterday. The forecast (50/day) is right. Stock + open PO are enough; buying more would overstock.",
    trigger: { kind: "DEMAND_ALERT", message: "Demand alert: CHOCO-BAR-50G at DS-BLR-01 has sold ~2.5x its baseline over the last 7 days. There is an existing open PO. Check whether the purchasing plan needs to change.", context: { sku: p.sku, nodeId: N } },
    world: w,
    expectations: {
      allowedDecisions: ["NO_CHANGE"],
      requiredEvidence: [EVIDENCE.demand, EVIDENCE.stock],
      newUnitsRange: [0, 0],
      trueDailyDemand: 50,
      noStockoutThroughDay: 10,
      rationaleMentions: [["promo", "promotion"]],
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 4 — Purchasing constraints
// ---------------------------------------------------------------------------

function s4Budget(): Scenario {
  const w = baseWorld();
  const p = product({ sku: "RICE-BASMATI-5KG", name: "Basmati Rice 5kg", category: "Staples", unitCost: 450, shelfLifeDays: 365, criticality: "high" });
  withSku(w, p, 60, series(H, 80, 0.06, 9), flat(H, 80), flat(42, 80));
  w.offers.push({ supplierId: "SUP-METRO", sku: p.sku, unitPrice: 450, moq: 100, caseSize: 20, leadTimeDays: 4, availableQty: 3000, active: true });
  w.budgets.push({ category: "Staples", periodLabel: "Sep-2026", limit: 900_000, committed: 700_000 });
  w.recommendations.push({ id: "REC-5001", sku: p.sku, nodeId: N, supplierId: "SUP-METRO", qty: 1060, generatedBy: "replenishment-engine v3 (nightly batch)", rationale: "Order-up-to for 11-day window incl. safety stock.", status: "OPEN" });
  return {
    id: "s4-budget",
    assignmentScenario: 4,
    title: "Need exceeds remaining budget → buy what fits + escalate",
    description: "The recommendation (1,060 units, ₹4.77L) is correct on demand, but only ₹2L of the Staples budget remains. The agent should buy the most it can within budget (≤440 units, which covers the lead time) and escalate for a budget extension rather than executing blindly.",
    trigger: { kind: "CONSTRAINED_PURCHASE", message: "Review purchase recommendation REC-5001: buy 1060 units of RICE-BASMATI-5KG for DS-BLR-01 from SUP-METRO.", context: { sku: p.sku, nodeId: N, recommendationId: "REC-5001" } },
    world: w,
    expectations: {
      allowedDecisions: ["MODIFY", "ESCALATE"],
      requiredEvidence: [EVIDENCE.budget, EVIDENCE.stock, EVIDENCE.demand],
      newUnitsRange: [320, 440],
      trueDailyDemand: 80,
      requiredActionTypes: ["CREATE_PO", "ESCALATE"],
      mustEscalate: true,
      rationaleMentions: [["budget"]],
    },
  };
}

function s4Storage(): Scenario {
  const w = baseWorld();
  const p = product({ sku: "PEAS-FROZEN-1KG", name: "Frozen Green Peas 1kg", category: "Frozen", unitCost: 110, storageZone: "frozen", shelfLifeDays: 180 });
  withSku(w, p, 150, series(H, 60, 0.08, 10), flat(H, 60), flat(42, 60));
  w.offers.push({ supplierId: "SUP-COLDCHAIN", sku: p.sku, unitPrice: 110, moq: 100, caseSize: 10, leadTimeDays: 2, availableQty: 3000, active: true });
  w.budgets.push({ category: "Frozen", periodLabel: "Sep-2026", limit: 400_000, committed: 100_000 });
  w.recommendations.push({ id: "REC-5101", sku: p.sku, nodeId: N, supplierId: "SUP-COLDCHAIN", qty: 800, generatedBy: "replenishment-engine v3 (nightly batch)", rationale: "Build ~2 weeks of cover ahead of month-end.", status: "OPEN" });
  return {
    id: "s4-storage",
    assignmentScenario: 4,
    title: "Frozen storage can't hold the order → split / reduce",
    description: "800 units recommended but only 400 units of freezer space are free for this SKU. The agent must reduce the first delivery to fit (~310) and optionally schedule a second delivery later instead of overflowing the freezer.",
    trigger: { kind: "CONSTRAINED_PURCHASE", message: "Review purchase recommendation REC-5101: buy 800 units of PEAS-FROZEN-1KG for DS-BLR-01 from SUP-COLDCHAIN.", context: { sku: p.sku, nodeId: N, recommendationId: "REC-5101" } },
    world: w,
    expectations: {
      allowedDecisions: ["MODIFY"],
      requiredEvidence: [EVIDENCE.stock, EVIDENCE.demand],
      newUnitsRange: [250, 800],
      trueDailyDemand: 60,
      noStockoutThroughDay: 7,
      requiredActionTypes: ["CREATE_PO"],
      rationaleMentions: [["storage", "capacity", "freezer", "space"]],
    },
  };
}

export const SCENARIOS: Scenario[] = [
  s1Accept(),
  s1OpenPO(),
  s1Reject(),
  s1Anomaly(),
  s2Alternate(),
  s2Sufficient(),
  s2Escalate(),
  s2FeedbackLoop(),
  s3Spike(),
  s3FalseSpike(),
  s4Budget(),
  s4Storage(),
];

export function getScenario(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown scenario ${id}`);
  return s;
}
