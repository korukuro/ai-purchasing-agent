/**
 * Mock supplier system. When a PO is submitted or changed, the supplier
 * answers with what it will ACTUALLY do — which can differ from what its
 * catalogue advertised (partial confirmation, rejection, delays, price change).
 * This is what makes the verification / feedback loop necessary.
 */
import type { PurchaseOrder } from "./types.js";
import { World } from "./world.js";

export interface SupplierResponse {
  status: "CONFIRMED" | "PARTIALLY_CONFIRMED" | "REJECTED_BY_SUPPLIER";
  qtyConfirmed: number;
  expectedArrivalDay: number;
  unitPrice: number;
  message: string;
}

export function supplierRespond(world: World, po: PurchaseOrder, requestedQty: number): SupplierResponse {
  const b = world.state.supplierBehavior[`${po.supplierId}:${po.sku}`] ?? {};
  const offer = world.offer(po.supplierId, po.sku);
  const caseSize = offer?.caseSize ?? 1;
  const name = world.supplier(po.supplierId).name;

  if (b.rejectAll) {
    return {
      status: "REJECTED_BY_SUPPLIER",
      qtyConfirmed: 0,
      expectedArrivalDay: po.expectedArrivalDay,
      unitPrice: po.unitPrice,
      message: `${name}: unable to accept order ${po.id} at this time.`,
    };
  }

  let qty = requestedQty;
  if (b.fillRatio !== undefined) qty = Math.floor((qty * b.fillRatio) / caseSize) * caseSize;
  if (b.maxConfirmQty !== undefined) qty = Math.min(qty, b.maxConfirmQty);
  const arrival = po.expectedArrivalDay + (b.leadTimeSlipDays ?? 0);
  const price = Math.round(po.unitPrice * (1 + (b.priceIncreasePct ?? 0) / 100) * 100) / 100;

  const parts: string[] = [];
  if (qty < requestedQty) parts.push(`can confirm only ${qty} of ${requestedQty} units`);
  if (arrival !== po.expectedArrivalDay) parts.push(`delivery moves to day ${arrival}`);
  if (price !== po.unitPrice) parts.push(`unit price revised to ${price}`);

  return {
    status: qty < requestedQty ? "PARTIALLY_CONFIRMED" : "CONFIRMED",
    qtyConfirmed: qty,
    expectedArrivalDay: arrival,
    unitPrice: price,
    message: parts.length ? `${name}: ${parts.join("; ")}.` : `${name}: order ${po.id} confirmed in full.`,
  };
}
