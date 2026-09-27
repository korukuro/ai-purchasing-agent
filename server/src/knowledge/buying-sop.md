# Buying Standard Operating Procedures (Dark-store replenishment)

## Reviewing system recommendations
Replenishment recommendations are generated nightly from the forecast snapshot. They can be stale: the snapshot may miss purchase orders created or confirmed after the batch ran, supplier exceptions received during the day, or manual forecast corrections. Always reconcile a recommendation against current on-hand stock and ALL open purchase orders before accepting it. A recommendation should be accepted as-is when the independently computed requirement is within roughly one case pack or ~10% of the recommended quantity.

## Order quantity policy
Target stock = demand over (supplier lead time + review period) + safety stock. The review period is 7 days and safety stock is 3 days of expected demand. Quantities must respect supplier MOQ and be multiples of the case size. Never order more than 30 days of cover for non-perishables without buyer approval.

## Perishables and shelf life
For perishable products the total days of cover (on hand + inbound + new order) must stay below 70% of shelf life. Ordering beyond that creates write-offs. When a perishable is already overstocked, reject new purchases and let stock sell down.

## Demand changes and forecast anomalies
Before reacting to a change in sales, establish whether it is sustained. Evidence of a real shift: several consecutive days above forecast, a rising 7-day average versus the 28-day average, and no promotion or one-off event explaining it. Evidence of a one-off: a single outlier day (e.g. a B2B bulk order), a promotion that has ended, or a stock-in event. If a forecast jumped because of a single outlier day, do not buy against it: open an investigation with the demand planning team. When a sustained increase is confirmed, re-plan using the recent run-rate (typically the last 7 days) rather than the stale forecast.

## Supplier exceptions and partial fulfilment
When a supplier cannot fulfil a PO in full: (1) accept the confirmed partial quantity so it stays on the way, (2) check whether stock on hand plus inbound covers demand until the next replenishment cycle, (3) if not, source the shortfall from an alternate supplier that can deliver before the projected stockout. Prefer alternates with fill rate above 85% even at a moderately higher price; a cheaper supplier that cannot deliver before the stockout does not solve the problem. If no alternate can cover the gap, escalate to the buyer with the options and the expected stockout date.

## Supplier reliability
Suppliers with a fill rate below 85% require buyer approval before new POs are placed with them. After placing a PO, always check the supplier's confirmation: a partial confirmation or a delivery slip means the plan must be re-evaluated.

## Budget constraints
Category budgets are hard limits for the period; the agent may not exceed them. When the required quantity does not fit the remaining budget, buy the quantity that protects availability for the most critical period (at least the lead time plus a few days), and escalate to the category manager with the shortfall and a request for a budget extension.

## Storage constraints
Each dark store zone (ambient, chilled, frozen) has a fixed capacity shared by all products. If the required quantity does not fit, split the order into multiple deliveries (schedule a later delivery day) rather than exceeding capacity, or escalate.

## Approvals and escalation
Autonomous actions are allowed when they are within budget, within policy and below the auto-approval value (₹1,50,000 per PO). Buyer approval is required for high-value POs, cancellations, low-reliability suppliers, ordering well above the recommendation, and overstock beyond policy. Escalate (do not act) when data is contradictory, when no compliant option exists, or when the decision needs commercial judgement (budget extensions, delisting, promotions).
