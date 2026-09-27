import { describe, expect, it } from "vitest";
import { calculateRequirement, demandSignals, projectInventory } from "../src/domain/planning.js";
import { evaluatePlan } from "../src/domain/policy.js";
import { executePlan, verifyOutcome } from "../src/domain/execution.js";
import { PlanSchema, type Plan } from "../src/domain/plan.js";
import { World } from "../src/domain/world.js";
import { getScenario } from "../src/scenarios/index.js";

const world = (id: string) => new World(getScenario(id).world);
const plan = (p: Partial<Plan>): Plan => PlanSchema.parse({ decision: "MODIFY", summary: "t", demandAssumption: { dailyRate: 45, basis: "t" }, ...p });

describe("planning math", () => {
  it("requirement nets out on-hand and inbound open POs (s1-open-po)", () => {
    const r = calculateRequirement(world("s1-open-po"), "COFFEE-100G", "DS-BLR-01", "SUP-METRO");
    // window 11d*50 + 3d*50 safety - 120 on hand - 400 inbound = 180
    expect(r.netRequirement).toBe(180);
    expect(r.suggestedOrderQty).toBe(180);
  });

  it("demand override changes the answer (stale forecast in s3)", () => {
    const w = world("s3-sustained-spike");
    expect(calculateRequirement(w, "ELECTROLYTE-500ML", "DS-BLR-01", "SUP-METRO").suggestedOrderQty).toBe(0);
    expect(calculateRequirement(w, "ELECTROLYTE-500ML", "DS-BLR-01", "SUP-METRO", 90).suggestedOrderQty).toBe(480);
  });

  it("projection finds the stockout day and counts supplier-proposed qty for exception POs", () => {
    const p = projectInventory(world("s2-alternate-supplier"), "OIL-SUNFLOWER-1L", "DS-BLR-01");
    expect(p.firstStockoutDay).toBe(8); // 90 on hand + 250 proposed on day 2, 45/day
  });

  it("demand signals flag a one-off outlier day", () => {
    const d = demandSignals(world("s1-forecast-anomaly"), "DETERGENT-1KG", "DS-BLR-01");
    expect(d.outlierDays).toHaveLength(1);
    expect(d.outlierDays[0].units).toBe(930);
  });
});

describe("policy guardrails", () => {
  it("blocks orders that break storage capacity and suggests split delivery", () => {
    const w = world("s4-storage");
    const res = evaluatePlan(w, plan({ demandAssumption: { dailyRate: 60, basis: "" }, actions: [{ type: "CREATE_PO", reason: "", supplierId: "SUP-COLDCHAIN", quantity: 800 }] }), { sku: "PEAS-FROZEN-1KG", nodeId: "DS-BLR-01", recommendationId: "REC-5101" });
    expect(res.ok).toBe(false);
    expect(res.findings.map((f) => f.code)).toContain("STORAGE_CAPACITY");

    const split = evaluatePlan(w, plan({ demandAssumption: { dailyRate: 60, basis: "" }, actions: [
      { type: "CREATE_PO", reason: "", supplierId: "SUP-COLDCHAIN", quantity: 310 },
      { type: "CREATE_PO", reason: "", supplierId: "SUP-COLDCHAIN", quantity: 260, deliveryDay: 7 },
    ] }), { sku: "PEAS-FROZEN-1KG", nodeId: "DS-BLR-01", recommendationId: "REC-5101" });
    expect(split.findings.filter((f) => f.severity === "BLOCK")).toEqual([]);
  });

  it("blocks budget overruns and routes high-value POs to approval", () => {
    const w = world("s4-budget");
    const ctx = { sku: "RICE-BASMATI-5KG", nodeId: "DS-BLR-01", recommendationId: "REC-5001" };
    const full = evaluatePlan(w, plan({ decision: "ACCEPT", actions: [{ type: "CREATE_PO", reason: "", supplierId: "SUP-METRO", quantity: 1060 }] }), ctx);
    expect(full.findings.map((f) => f.code)).toContain("BUDGET_EXCEEDED");
    const fits = evaluatePlan(w, plan({ actions: [{ type: "CREATE_PO", reason: "", supplierId: "SUP-METRO", quantity: 440 }] }), ctx);
    expect(fits.ok).toBe(true);
    expect(fits.requiresApproval).toBe(true); // ₹1.98L > ₹1.5L auto-approve
  });

  it("blocks perishable overstock and MOQ/case violations", () => {
    const w = world("s1-reject");
    const r = evaluatePlan(w, plan({ decision: "ACCEPT", actions: [{ type: "CREATE_PO", reason: "", supplierId: "SUP-DAIRY", quantity: 810 }] }), { sku: "YOGURT-400G", nodeId: "DS-BLR-01", recommendationId: "REC-1003" });
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("SHELF_LIFE");
    expect(codes).toContain("CASE_SIZE");
  });

  it("rejects a plan whose own expected outcome is contradicted by the simulation", () => {
    const w = world("s2-alternate-supplier");
    const r = evaluatePlan(w, plan({ actions: [{ type: "ACCEPT_PARTIAL", reason: "", poId: "PO-3001" }], expectedOutcome: { noStockoutThroughDay: 9 } }), { sku: "OIL-SUNFLOWER-1L", nodeId: "DS-BLR-01", poId: "PO-3001" });
    expect(r.findings.map((f) => f.code)).toContain("PLAN_INCONSISTENT");
  });
});

describe("execution + verification", () => {
  it("detects a supplier that confirms less than ordered (s2-feedback-loop)", () => {
    const w = world("s2-feedback-loop");
    const ctx = { sku: "OIL-MUSTARD-1L", nodeId: "DS-BLR-01", poId: "PO-3001" };
    const p = plan({ actions: [
      { type: "ACCEPT_PARTIAL", reason: "", poId: "PO-3001", quantity: 250 },
      { type: "CREATE_PO", reason: "", supplierId: "SUP-METRO", quantity: 200 },
    ], expectedOutcome: { noStockoutThroughDay: 10 } });
    expect(evaluatePlan(w, p, ctx).ok).toBe(true);
    const exec = executePlan(w, p, ctx);
    const v = verifyOutcome(w, p, ctx, exec);
    expect(v.ok).toBe(false);
    const failed = v.checks.filter((c) => !c.passed).map((c) => c.name);
    expect(failed.some((n) => n.endsWith("quantity"))).toBe(true);
    expect(failed).toContain("no stockout (expected outcome)");
  });

  it("keeps budget committed in sync with confirmed quantities", () => {
    const w = world("s2-alternate-supplier");
    const before = w.budget("Staples").committed;
    const ctx = { sku: "OIL-SUNFLOWER-1L", nodeId: "DS-BLR-01", poId: "PO-3001" };
    executePlan(w, plan({ actions: [{ type: "CREATE_PO", reason: "", supplierId: "SUP-METRO", quantity: 200 }] }), ctx);
    expect(w.budget("Staples").committed).toBe(before + 200 * 132);
  });
});
