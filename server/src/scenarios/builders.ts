import type {
  BuyingPolicy,
  FulfillmentNode,
  Supplier,
  WorldState,
} from "../domain/types.js";

export const DEFAULT_POLICY: BuyingPolicy = {
  currency: "₹",
  reviewPeriodDays: 7,
  safetyStockDays: 3,
  maxDaysOfCover: 30,
  perishableCoverFraction: 0.7,
  autoApproveMaxValue: 150_000,
  maxDeviationFromRecommendationPct: 25,
  minSupplierFillRate: 0.85,
  planningHorizonDays: 21,
};

export const NODE: FulfillmentNode = {
  id: "DS-BLR-01",
  name: "Koramangala Dark Store",
  city: "Bangalore",
  zones: {
    ambient: { capacityUnits: 12_000, otherProductsUnits: 7_000 },
    chilled: { capacityUnits: 3_000, otherProductsUnits: 1_800 },
    frozen: { capacityUnits: 1_000, otherProductsUnits: 600 },
  },
};

export const SUPPLIERS: Supplier[] = [
  { id: "SUP-FRESHFIELDS", name: "FreshFields Distributors", fillRate: 0.93, onTimeRate: 0.95, incidents: ["D-40: 1 short shipment (8% short) on edible oils"] },
  { id: "SUP-METRO", name: "Metro Wholesale", fillRate: 0.96, onTimeRate: 0.97, incidents: [] },
  { id: "SUP-BUDGET", name: "BudgetMart Traders", fillRate: 0.72, onTimeRate: 0.7, incidents: ["D-21: delivered 60% of PO", "D-9: 4 days late", "D-3: price revised after confirmation"] },
  { id: "SUP-QUICK", name: "QuickSupply Co.", fillRate: 0.87, onTimeRate: 0.9, incidents: ["D-30: 2 days late"] },
  { id: "SUP-DAIRY", name: "Nandi Dairy Co-op", fillRate: 0.95, onTimeRate: 0.96, incidents: [] },
  { id: "SUP-COLDCHAIN", name: "ColdChain Foods", fillRate: 0.94, onTimeRate: 0.93, incidents: [] },
];

/** Deterministic "noisy" series so fixtures look realistic but are reproducible. */
export function series(days: number, base: number, amp = 0.08, phase = 0): number[] {
  return Array.from({ length: days }, (_, i) => Math.round(base * (1 + amp * Math.sin(i * 1.7 + phase))));
}

export function flat(days: number, v: number): number[] {
  return Array.from({ length: days }, () => v);
}

/** A mostly-empty world containing the shared master data. */
export function baseWorld(): WorldState {
  return {
    today: 0,
    policy: { ...DEFAULT_POLICY },
    products: [],
    nodes: [structuredClone(NODE)],
    inventory: [],
    demand: [],
    promotions: [],
    suppliers: structuredClone(SUPPLIERS),
    offers: [],
    purchaseOrders: [],
    budgets: [],
    recommendations: [],
    supplierMessages: [],
    escalations: [],
    decisionHistory: [],
    supplierBehavior: {},
  };
}
