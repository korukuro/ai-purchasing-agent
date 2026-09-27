import type {
  Budget,
  DemandRecord,
  FulfillmentNode,
  InventoryRecord,
  Product,
  PurchaseOrder,
  Supplier,
  SupplierOffer,
  WorldState,
} from "./types.js";

/** PO statuses that still represent stock on its way to the node. */
export const OPEN_PO_STATUSES = new Set([
  "SUBMITTED",
  "CONFIRMED",
  "PARTIALLY_CONFIRMED",
  "SUPPLIER_EXCEPTION",
]);

export class NotFoundError extends Error {}

/**
 * In-memory "system of record" for one run. Every agent run gets its own
 * deep copy of a scenario's world so runs are isolated and reproducible.
 * In production this would be a repository layer over Postgres.
 */
export class World {
  readonly state: WorldState;
  private seq = 1000;

  constructor(initial: WorldState) {
    this.state = structuredClone(initial);
    const maxPo = Math.max(
      0,
      ...this.state.purchaseOrders.map((p) => Number(p.id.replace(/\D/g, "")) || 0),
    );
    this.seq = Math.max(this.seq, maxPo) + 1;
  }

  get today() {
    return this.state.today;
  }
  get policy() {
    return this.state.policy;
  }

  nextId(prefix: string) {
    return `${prefix}-${this.seq++}`;
  }

  product(sku: string): Product {
    const p = this.state.products.find((x) => x.sku === sku);
    if (!p) throw new NotFoundError(`Unknown sku ${sku}`);
    return p;
  }

  node(nodeId: string): FulfillmentNode {
    const n = this.state.nodes.find((x) => x.id === nodeId);
    if (!n) throw new NotFoundError(`Unknown node ${nodeId}`);
    return n;
  }

  inventory(sku: string, nodeId: string): InventoryRecord {
    return (
      this.state.inventory.find((x) => x.sku === sku && x.nodeId === nodeId) ?? {
        sku,
        nodeId,
        onHand: 0,
      }
    );
  }

  demand(sku: string, nodeId: string): DemandRecord {
    const d = this.state.demand.find((x) => x.sku === sku && x.nodeId === nodeId);
    if (!d) throw new NotFoundError(`No demand data for ${sku}@${nodeId}`);
    return d;
  }

  supplier(id: string): Supplier {
    const s = this.state.suppliers.find((x) => x.id === id);
    if (!s) throw new NotFoundError(`Unknown supplier ${id}`);
    return s;
  }

  offer(supplierId: string, sku: string): SupplierOffer | undefined {
    return this.state.offers.find((o) => o.supplierId === supplierId && o.sku === sku);
  }

  offersFor(sku: string): SupplierOffer[] {
    return this.state.offers.filter((o) => o.sku === sku);
  }

  po(id: string): PurchaseOrder {
    const p = this.state.purchaseOrders.find((x) => x.id === id);
    if (!p) throw new NotFoundError(`Unknown purchase order ${id}`);
    return p;
  }

  openPOs(sku: string, nodeId: string): PurchaseOrder[] {
    return this.state.purchaseOrders.filter(
      (p) => p.sku === sku && p.nodeId === nodeId && OPEN_PO_STATUSES.has(p.status),
    );
  }

  budget(category: string): Budget {
    const b = this.state.budgets.find((x) => x.category === category);
    if (!b) throw new NotFoundError(`No budget for category ${category}`);
    return b;
  }

  recommendation(id: string) {
    const r = this.state.recommendations.find((x) => x.id === id);
    if (!r) throw new NotFoundError(`Unknown recommendation ${id}`);
    return r;
  }

  /** Quantity we can currently count on from a PO. */
  static effectiveInboundQty(po: PurchaseOrder): number {
    switch (po.status) {
      case "CONFIRMED":
      case "PARTIALLY_CONFIRMED":
        return po.qtyConfirmed ?? po.qtyOrdered;
      case "SUBMITTED":
        return po.qtyOrdered;
      case "SUPPLIER_EXCEPTION":
        return po.proposedQty ?? 0;
      default:
        return 0;
    }
  }

  /** Value of a PO that is committed against the budget. */
  static committedValue(po: PurchaseOrder): number {
    return World.effectiveInboundQty(po) * po.unitPrice;
  }

  snapshot(): WorldState {
    return structuredClone(this.state);
  }
}
