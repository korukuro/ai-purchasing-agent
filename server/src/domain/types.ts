/**
 * Domain model for the purchasing world.
 *
 * Time is modelled as integer day offsets relative to "today" (day 0) so the
 * planning math stays simple and every scenario is reproducible:
 *   - salesHistory[i]  -> actual units sold on day (i - salesHistory.length)
 *   - forecast[i]      -> forecast units for day (i + 1)
 */

export type StorageZone = "ambient" | "chilled" | "frozen";

export interface Product {
  sku: string;
  name: string;
  category: string;
  unitCost: number; // reference cost, used for budget estimates
  storageZone: StorageZone;
  shelfLifeDays: number | null; // null = non-perishable
  criticality: "normal" | "high"; // high = availability-critical (e.g. staples)
}

export interface FulfillmentNode {
  id: string;
  name: string;
  city: string;
  zones: Record<StorageZone, { capacityUnits: number; otherProductsUnits: number }>;
}

export interface InventoryRecord {
  sku: string;
  nodeId: string;
  onHand: number;
}

export interface Promotion {
  sku: string;
  name: string;
  startDay: number; // inclusive, can be negative (past)
  endDay: number; // inclusive
  upliftPct: number;
}

export interface DemandRecord {
  sku: string;
  nodeId: string;
  salesHistory: number[]; // last N days of actual sales, oldest first
  pastForecast: number[]; // what the forecast said for the same last N days
  forecast: number[]; // daily forecast for the next days (day 1..)
  notes?: string[]; // operational notes visible to the agent (e.g. "B2B bulk order on D-4")
}

export interface Supplier {
  id: string;
  name: string;
  fillRate: number; // historical % of ordered units actually delivered
  onTimeRate: number;
  incidents: string[]; // short free-text history ("memory" of supplier behaviour)
}

export interface SupplierOffer {
  supplierId: string;
  sku: string;
  unitPrice: number;
  moq: number;
  caseSize: number; // orders must be multiples of caseSize
  leadTimeDays: number;
  availableQty: number; // what the supplier catalogue *claims* is available
  active: boolean;
}

export type POStatus =
  | "SUBMITTED" // sent to supplier, awaiting confirmation
  | "CONFIRMED"
  | "PARTIALLY_CONFIRMED"
  | "SUPPLIER_EXCEPTION" // supplier raised a problem; proposedQty holds what they can do
  | "REJECTED_BY_SUPPLIER"
  | "CANCELLED"
  | "RECEIVED";

export interface PurchaseOrder {
  id: string;
  supplierId: string;
  sku: string;
  nodeId: string;
  qtyOrdered: number;
  qtyConfirmed: number | null;
  proposedQty?: number | null; // for SUPPLIER_EXCEPTION
  unitPrice: number;
  status: POStatus;
  createdDay: number;
  expectedArrivalDay: number;
  createdBy: "system" | "buyer" | "agent";
  history: { day: number; event: string }[];
}

export interface Budget {
  category: string;
  periodLabel: string;
  limit: number;
  committed: number;
}

export interface Recommendation {
  id: string;
  sku: string;
  nodeId: string;
  supplierId: string;
  qty: number;
  generatedBy: string;
  rationale: string;
  status: "OPEN" | "ACCEPTED" | "MODIFIED" | "REJECTED" | "UNDER_INVESTIGATION" | "ESCALATED";
  resolvedQty?: number;
}

export interface SupplierMessage {
  id: string;
  supplierId: string;
  poId?: string;
  receivedDay: number;
  channel: "email" | "portal";
  subject: string;
  body: string;
}

export interface Escalation {
  id: string;
  kind: "ESCALATION" | "INVESTIGATION";
  sku: string;
  nodeId: string;
  reason: string;
  questionForBuyer: string;
  createdDay: number;
  runId?: string;
}

export interface DecisionRecord {
  day: number;
  sku: string;
  decision: string;
  summary: string;
}

/** Behaviour of the mock supplier system when it receives a new/changed PO. */
export interface SupplierBehavior {
  /** Real capacity for this SKU. The catalogue may advertise more (availableQty). */
  maxConfirmQty?: number;
  /** Fraction of ordered qty the supplier confirms (applied before maxConfirmQty). */
  fillRatio?: number;
  rejectAll?: boolean;
  leadTimeSlipDays?: number;
  priceIncreasePct?: number;
}

export interface BuyingPolicy {
  currency: string;
  reviewPeriodDays: number; // how often the SKU is re-planned
  safetyStockDays: number;
  maxDaysOfCover: number; // above this -> overstock (approval needed)
  perishableCoverFraction: number; // cover must stay below shelfLife * fraction
  autoApproveMaxValue: number; // PO value above this requires buyer approval
  maxDeviationFromRecommendationPct: number; // bigger change vs recommendation -> approval
  minSupplierFillRate: number; // below this -> approval needed
  planningHorizonDays: number;
}

export interface WorldState {
  today: number;
  policy: BuyingPolicy;
  products: Product[];
  nodes: FulfillmentNode[];
  inventory: InventoryRecord[];
  demand: DemandRecord[];
  promotions: Promotion[];
  suppliers: Supplier[];
  offers: SupplierOffer[];
  purchaseOrders: PurchaseOrder[];
  budgets: Budget[];
  recommendations: Recommendation[];
  supplierMessages: SupplierMessage[];
  escalations: Escalation[];
  decisionHistory: DecisionRecord[];
  supplierBehavior: Record<string, SupplierBehavior>; // key: `${supplierId}:${sku}`
}
