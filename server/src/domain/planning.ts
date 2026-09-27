/**
 * Deterministic planning math. The LLM never does arithmetic on its own:
 * it calls these functions through tools, and the verifier and the eval
 * oracle use exactly the same functions, so everyone "sees" the same numbers.
 */
import { World } from "./world.js";

const round1 = (n: number) => Math.round(n * 10) / 10;
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const avg = (a: number[]) => (a.length ? sum(a) / a.length : 0);
const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function demandSignals(world: World, sku: string, nodeId: string) {
  const d = world.demand(sku, nodeId);
  const h = d.salesHistory;
  const n = h.length;
  const last = (k: number) => h.slice(Math.max(0, n - k));
  const med = median(h);

  const outliers = h
    .map((units, i) => ({ day: i - n, units }))
    .filter((x) => med > 0 && x.units > 3 * med);

  const lastK = Math.min(14, d.pastForecast.length, n);
  const actual14 = sum(last(lastK));
  const fc14 = sum(d.pastForecast.slice(d.pastForecast.length - lastK));

  const promos = world.state.promotions
    .filter((p) => p.sku === sku && p.endDay >= -28)
    .map((p) => ({
      ...p,
      state: p.endDay < 0 ? "ENDED" : p.startDay > 0 ? "UPCOMING" : "ACTIVE",
    }));

  return {
    sku,
    nodeId,
    salesLast14Days: last(14).map((units, i) => ({ day: i - Math.min(14, n), units })),
    avgDailySales: {
      last3: round1(avg(last(3))),
      last7: round1(avg(last(7))),
      last14: round1(avg(last(14))),
      last28: round1(avg(last(28))),
      medianAllHistory: round1(med),
    },
    trendRatio7vs28: round1(avg(last(7)) / Math.max(0.1, avg(last(28)))),
    outlierDays: outliers,
    forecastNext14: d.forecast.slice(0, 14),
    avgDailyForecast: {
      next7: round1(avg(d.forecast.slice(0, 7))),
      next14: round1(avg(d.forecast.slice(0, 14))),
    },
    forecastAccuracyLast14Days: {
      actualUnits: actual14,
      forecastUnits: fc14,
      actualVsForecastRatio: round1(actual14 / Math.max(1, fc14)),
    },
    promotions: promos,
    notes: d.notes ?? [],
  };
}

export interface HypotheticalOrder {
  supplierId: string;
  qty: number;
  arrivalDay?: number; // default: today + supplier lead time
}

export interface ProjectionOptions {
  extraOrders?: HypotheticalOrder[];
  poQtyOverrides?: Record<string, number>; // poId -> qty we'd count on
  dailyDemand?: number; // override the system forecast with a flat daily rate
  horizonDays?: number;
}

export interface ProjectionDay {
  day: number;
  demand: number;
  arrivals: number;
  closingStock: number;
  lostSales: number;
}

export function projectInventory(
  world: World,
  sku: string,
  nodeId: string,
  opts: ProjectionOptions = {},
) {
  const horizon = opts.horizonDays ?? world.policy.planningHorizonDays;
  const d = world.demand(sku, nodeId);
  const product = world.product(sku);
  const zone = world.node(nodeId).zones[product.storageZone];

  const arrivals = new Map<number, number>();
  const add = (day: number, qty: number) => arrivals.set(day, (arrivals.get(day) ?? 0) + qty);

  for (const po of world.openPOs(sku, nodeId)) {
    const qty = opts.poQtyOverrides?.[po.id] ?? World.effectiveInboundQty(po);
    add(Math.max(1, po.expectedArrivalDay - world.today), qty);
  }
  for (const o of opts.extraOrders ?? []) {
    const offer = world.offer(o.supplierId, sku);
    const lt = offer?.leadTimeDays ?? 0;
    add(Math.max(1, o.arrivalDay ?? lt), o.qty);
  }

  let stock = world.inventory(sku, nodeId).onHand;
  let peakStock = stock;
  let firstStockoutDay: number | null = null;
  let totalLost = 0;
  const days: ProjectionDay[] = [];
  for (let day = 1; day <= horizon; day++) {
    const arr = arrivals.get(day) ?? 0;
    stock += arr;
    peakStock = Math.max(peakStock, stock);
    const demand = opts.dailyDemand ?? d.forecast[day - 1] ?? d.forecast[d.forecast.length - 1] ?? 0;
    const served = Math.min(stock, demand);
    const lost = round1(demand - served);
    stock = round1(stock - served);
    if (lost > 0 && firstStockoutDay === null) firstStockoutDay = day;
    totalLost += lost;
    days.push({ day, demand: round1(demand), arrivals: arr, closingStock: stock, lostSales: lost });
  }

  const zoneFree = zone.capacityUnits - zone.otherProductsUnits;
  const avgDemand = opts.dailyDemand ?? avg(d.forecast.slice(0, horizon));
  const totalSupply = world.inventory(sku, nodeId).onHand + sum([...arrivals.values()]);

  return {
    sku,
    nodeId,
    demandBasis: opts.dailyDemand !== undefined ? `flat ${opts.dailyDemand}/day` : "system forecast",
    startingOnHand: world.inventory(sku, nodeId).onHand,
    firstStockoutDay,
    totalLostSales: round1(totalLost),
    peakStock,
    storage: {
      zone: product.storageZone,
      freeCapacityForThisSku: zoneFree,
      peakUtilisationPct: round1((100 * (peakStock + zone.otherProductsUnits)) / zone.capacityUnits),
      exceedsCapacity: peakStock > zoneFree,
    },
    daysOfCoverTotal: round1(totalSupply / Math.max(0.1, avgDemand)),
    endingStock: stock,
    days,
  };
}

/**
 * Classic periodic-review order-up-to logic:
 *   need = demand over (lead time + review period) + safety stock
 *          - on hand - inbound arriving within that window
 * rounded up to case size and MOQ.
 */
export function calculateRequirement(
  world: World,
  sku: string,
  nodeId: string,
  supplierId: string,
  dailyDemand?: number,
) {
  const offer = world.offer(supplierId, sku);
  if (!offer) throw new Error(`Supplier ${supplierId} does not offer ${sku}`);
  const p = world.policy;
  const d = world.demand(sku, nodeId);
  const window = offer.leadTimeDays + p.reviewPeriodDays;
  const perDay = (i: number) => dailyDemand ?? d.forecast[i] ?? d.forecast[d.forecast.length - 1] ?? 0;
  let windowDemand = 0;
  for (let i = 0; i < window; i++) windowDemand += perDay(i);
  const avgDaily = dailyDemand ?? avg(d.forecast.slice(0, 14));
  const safetyStock = p.safetyStockDays * avgDaily;
  const onHand = world.inventory(sku, nodeId).onHand;
  const inbound = world
    .openPOs(sku, nodeId)
    .filter((po) => po.expectedArrivalDay - world.today <= window)
    .reduce((s, po) => s + World.effectiveInboundQty(po), 0);

  const net = Math.max(0, windowDemand + safetyStock - onHand - inbound);
  let orderQty = net > 0 ? Math.ceil(net / offer.caseSize) * offer.caseSize : 0;
  if (orderQty > 0 && orderQty < offer.moq) orderQty = Math.ceil(offer.moq / offer.caseSize) * offer.caseSize;

  return {
    sku,
    nodeId,
    supplierId,
    demandBasis: dailyDemand !== undefined ? `flat ${dailyDemand}/day` : "system forecast",
    coverageWindowDays: window,
    breakdown: {
      demandOverWindow: round1(windowDemand),
      safetyStock: round1(safetyStock),
      onHand,
      inboundWithinWindow: inbound,
    },
    netRequirement: round1(net),
    suggestedOrderQty: orderQty,
    roundingNote:
      orderQty > net
        ? `rounded up to case size ${offer.caseSize}${orderQty === Math.ceil(offer.moq / offer.caseSize) * offer.caseSize ? ` / MOQ ${offer.moq}` : ""}`
        : undefined,
    estimatedCost: orderQty * offer.unitPrice,
  };
}
