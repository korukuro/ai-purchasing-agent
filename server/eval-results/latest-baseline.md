# Evaluation report — baseline:blind-executor

Run 2026-09-27T14:18:59.941Z · 12 run(s) over 12 scenario(s) · 1 trial(s) each

**Pass rate: 0%** · average dimension score 36% · avg 2 LLM calls / 0 tool calls per run

| Scenario | Decision | New units | decision | information | constraints | action | validation | recovery | explanation | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| s1-accept | ACCEPT | 800 | ✅ | ❌ | ✅ | ✅ | ❌ | — | ✅ | ❌ |
| s1-open-po | NONE | 0 | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| s1-reject | NONE | 0 | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| s1-forecast-anomaly | ACCEPT | 800 | ❌ | ❌ | ✅ | ❌ | ❌ | — | ❌ | ❌ |
| s2-alternate-supplier | ACCEPT | 0 | ✅ | ❌ | ✅ | ❌ | ✅ | — | ❌ | ❌ |
| s2-inventory-sufficient | ACCEPT | 0 | ✅ | ❌ | ✅ | ✅ | ✅ | — | ❌ | ❌ |
| s2-no-good-alternative | ACCEPT | 0 | ❌ | ❌ | ✅ | ❌ | ✅ | — | ❌ | ❌ |
| s2-feedback-loop | ACCEPT | 0 | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| s3-sustained-spike | NO_CHANGE | 0 | ❌ | ❌ | ✅ | ❌ | ✅ | — | ❌ | ❌ |
| s3-promo-spike | NO_CHANGE | 0 | ✅ | ❌ | ✅ | ✅ | ✅ | — | ❌ | ❌ |
| s4-budget | NONE | 0 | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| s4-storage | NONE | 0 | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

## Failures

- **s1-accept** · Did it obtain the necessary information? — never checked current on-hand stock (get_inventory_position | calculate_requirement | simulate_plan); never checked existing open purchase orders (get_open_purchase_orders | get_inventory_position); never checked actual sales vs forecast (get_demand_signals); never checked remaining purchasing budget (get_budget)
- **s1-accept** · Did it validate the result? — agent never stated a verifiable expected outcome
- **s1-open-po** · Was the decision correct? — final decision NONE; acceptable: MODIFY
- **s1-open-po** · Did it obtain the necessary information? — never checked current on-hand stock (get_inventory_position | calculate_requirement | simulate_plan); never checked existing open purchase orders (get_open_purchase_orders | get_inventory_position); never checked actual sales vs forecast (get_demand_signals)
- **s1-open-po** · Did it take the appropriate action? — net new units 0 outside expected [120, 300]; missing required action CREATE_PO; with TRUE demand (50/day) stock runs out on day 11 (need none through day 11); system had to escalate because the agent could not finish
- **s1-open-po** · Did it validate the result? — no plan was executed
- **s1-open-po** · Did it handle a failed / blocked action? — plan was blocked by guardrails; agent did not recover
- **s1-open-po** · Did it explain the important factors? — rationale never mentions any of: PO-2001, open po, open purchase order, inbound, incoming
- **s1-reject** · Was the decision correct? — final decision NONE; acceptable: REJECT
- **s1-reject** · Did it obtain the necessary information? — never checked current on-hand stock (get_inventory_position | calculate_requirement | simulate_plan); never checked existing open purchase orders (get_open_purchase_orders | get_inventory_position); never checked actual sales vs forecast (get_demand_signals)
- **s1-reject** · Did it take the appropriate action? — net new units 0 within [0, 0]; no stockout through day 14 at true demand; system had to escalate because the agent could not finish
- **s1-reject** · Did it validate the result? — no plan was executed
- **s1-reject** · Did it handle a failed / blocked action? — plan was blocked by guardrails; agent did not recover
- **s1-reject** · Did it explain the important factors? — rationale never mentions any of: shelf, perish, expir, waste, write-off, overstock, days of cover
- **s1-forecast-anomaly** · Was the decision correct? — final decision ACCEPT; acceptable: INVESTIGATE / ESCALATE / REJECT
- **s1-forecast-anomaly** · Did it obtain the necessary information? — never checked current on-hand stock (get_inventory_position | calculate_requirement | simulate_plan); never checked actual sales vs forecast (get_demand_signals)
- **s1-forecast-anomaly** · Did it take the appropriate action? — net new units 800 outside expected [0, 120]; no stockout through day 12 at true demand
- **s1-forecast-anomaly** · Did it validate the result? — agent never stated a verifiable expected outcome
- **s1-forecast-anomaly** · Did it explain the important factors? — rationale never mentions any of: outlier, one-off, one off, bulk, b2b, institutional, anomal, single day, spike
- **s2-alternate-supplier** · Did it obtain the necessary information? — never checked what the supplier actually said (get_supplier_messages | get_purchase_order); never checked current on-hand stock (get_inventory_position | calculate_requirement | simulate_plan); never checked actual sales vs forecast (get_demand_signals); never checked supplier MOQ / lead time / alternates (get_supplier_options)
- **s2-alternate-supplier** · Did it take the appropriate action? — net new units 0 outside expected [180, 450]; missing required action CREATE_PO; with TRUE demand (45/day) stock runs out on day 8 (need none through day 10)
- **s2-alternate-supplier** · Did it explain the important factors? — rationale never mentions any of: stockout, stock-out, stock out, run out, cover
- **s2-inventory-sufficient** · Did it obtain the necessary information? — never checked what the supplier actually said (get_supplier_messages | get_purchase_order); never checked current on-hand stock (get_inventory_position | calculate_requirement | simulate_plan); never checked actual sales vs forecast (get_demand_signals)
- **s2-inventory-sufficient** · Did it explain the important factors? — no key factors given
- **s2-no-good-alternative** · Was the decision correct? — final decision ACCEPT; acceptable: ESCALATE / MODIFY
- **s2-no-good-alternative** · Did it obtain the necessary information? — never checked what the supplier actually said (get_supplier_messages | get_purchase_order); never checked current on-hand stock (get_inventory_position | calculate_requirement | simulate_plan); never checked supplier MOQ / lead time / alternates (get_supplier_options)
- **s2-no-good-alternative** · Did it take the appropriate action? — net new units 0 within [0, 400]; missing required action ESCALATE; should have escalated to the buyer
- **s2-no-good-alternative** · Did it explain the important factors? — no key factors given
- **s2-feedback-loop** · Did it obtain the necessary information? — never checked what the supplier actually said (get_supplier_messages | get_purchase_order); never checked current on-hand stock (get_inventory_position | calculate_requirement | simulate_plan); never checked supplier MOQ / lead time / alternates (get_supplier_options)
- **s2-feedback-loop** · Did it take the appropriate action? — net new units 0 outside expected [180, 450]; missing required action CREATE_PO; with TRUE demand (45/day) stock runs out on day 8 (need none through day 10)
- **s2-feedback-loop** · Did it handle a failed / blocked action? — expected a failed action to recover from, but none occurred (agent may have avoided it — check trace)
- **s2-feedback-loop** · Did it explain the important factors? — no key factors given
- **s3-sustained-spike** · Was the decision correct? — final decision NO_CHANGE; acceptable: MODIFY
- **s3-sustained-spike** · Did it obtain the necessary information? — never checked actual sales vs forecast (get_demand_signals); never checked current on-hand stock (get_inventory_position | calculate_requirement | simulate_plan); never checked existing open purchase orders (get_open_purchase_orders | get_inventory_position)
- **s3-sustained-spike** · Did it take the appropriate action? — net new units 0 outside expected [360, 1100]; with TRUE demand (90/day) stock runs out on day 8 (need none through day 10)
- **s3-sustained-spike** · Did it explain the important factors? — rationale never mentions any of: trend, sustain, consecutive, heatwave, run-rate, run rate, 7-day, last 7
- **s3-promo-spike** · Did it obtain the necessary information? — never checked actual sales vs forecast (get_demand_signals); never checked current on-hand stock (get_inventory_position | calculate_requirement | simulate_plan)
- **s3-promo-spike** · Did it explain the important factors? — rationale never mentions any of: promo, promotion
- **s4-budget** · Was the decision correct? — final decision NONE; acceptable: MODIFY / ESCALATE
- **s4-budget** · Did it obtain the necessary information? — never checked remaining purchasing budget (get_budget); never checked current on-hand stock (get_inventory_position | calculate_requirement | simulate_plan); never checked actual sales vs forecast (get_demand_signals)
- **s4-budget** · Did it take the appropriate action? — net new units 0 outside expected [320, 440]; missing required action CREATE_PO; missing required action ESCALATE; should have escalated to the buyer
- **s4-budget** · Did it validate the result? — no plan was executed
- **s4-budget** · Did it handle a failed / blocked action? — plan was blocked by guardrails; agent did not recover
- **s4-budget** · Did it explain the important factors? — rationale never mentions any of: budget
- **s4-storage** · Was the decision correct? — final decision NONE; acceptable: MODIFY
- **s4-storage** · Did it obtain the necessary information? — never checked current on-hand stock (get_inventory_position | calculate_requirement | simulate_plan); never checked actual sales vs forecast (get_demand_signals)
- **s4-storage** · Did it take the appropriate action? — net new units 0 outside expected [250, 800]; missing required action CREATE_PO; with TRUE demand (60/day) stock runs out on day 3 (need none through day 7); system had to escalate because the agent could not finish
- **s4-storage** · Did it validate the result? — no plan was executed
- **s4-storage** · Did it handle a failed / blocked action? — plan was blocked by guardrails; agent did not recover
- **s4-storage** · Did it explain the important factors? — rationale never mentions any of: storage, capacity, freezer, space
