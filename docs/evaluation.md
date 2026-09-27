# Evaluation approach

## What "correct" means here

A purchasing decision has no single right number, but it has a **defensible range** and a set of **hard failures**. So each scenario carries ground truth that the agent never sees (`server/src/scenarios/index.ts → expectations`):

| Field | Meaning |
|---|---|
| `allowedDecisions` | Decisions a competent buyer could take (e.g. `ACCEPT` or `MODIFY` when the recommendation is within ~10%) |
| `newUnitsRange` | Net new units that should end up inbound for the SKU, measured on the system of record after the run |
| `trueDailyDemand` | The real underlying demand, which may differ from the system forecast (stale forecast, one-off outlier, ended promo) |
| `noStockoutThroughDay` | With **true** demand, the resulting state must not stock out before this day |
| `requiredEvidence` | Information a buyer must have looked at (any-of tool groups) |
| `requiredActionTypes` / `mustEscalate` | e.g. accept the partial *and* source the gap; escalate when nothing compliant exists |
| `expectReplan` | The scenario is rigged so the first action fails in execution |
| `rationaleMentions` | Keywords the explanation must touch (e.g. the open PO, shelf life, the promotion) |

## How a run is graded

`server/src/eval/grader.ts` scores every run on the seven questions from the brief. It uses **only the trace and the before/after world state**, never the agent's own claims:

| Dimension | Check |
|---|---|
| Decision correct? | final executed decision ∈ `allowedDecisions` |
| Necessary information? | every `requiredEvidence` group was called |
| Constraints respected? | on the resulting state: budget ≤ limit, storage peak ≤ capacity (true demand), perishable cover, MOQ/case, no approval-required plan executed without approval |
| Appropriate action? | net new units in range, required action types executed, escalation raised when needed, no stockout through the target day **at true demand**, no system-forced escalation |
| Validated the result? | every executed plan was verified, the agent stated a verifiable expected outcome, and the run did not end on a failing verification without escalation |
| Handled failure? | if a plan was blocked or execution deviated: did it end verified or with an agent escalation? (N/A when nothing failed; FAIL if `expectReplan` but no failure happened) |
| Explained factors? | key factors present and mention the scenario's decisive factor |

A run **passes** only if every applicable dimension passes. Scores per dimension are reported so a regression is localised (e.g. "information" dropping means the prompt/tool descriptions got worse, "constraints" dropping would mean the guardrails broke).

## Scenarios and worked numbers

All numbers below come from the same `planning.ts` functions the agent can call.
Policy: review period 7d, safety stock 3d, target window = lead time + 7d.

| # | Scenario | Setup | Expected |
|---|---|---|---|
| 1 | `s1-accept` | 150 on hand, 70/day, no POs, LT 3d. Need = 70×10 + 210 − 150 = **760**; rec 800 | ACCEPT/MODIFY, 720–880 units |
| 1 | `s1-open-po` | 120 on hand, 50/day, **confirmed PO-2001 400 arriving day 2** that the stale snapshot missed. Need = 550 + 150 − 120 − 400 = **180**; rec 800 is also not a case multiple | MODIFY, 120–300 |
| 1 | `s1-reject` | Yogurt, 12d shelf life, 520 on hand + 200 inbound at 35/day = 20.6d cover (limit 8.4d); rec cites a promo not in the calendar | REJECT, 0 units |
| 1 | `s1-forecast-anomaly` | One 930-unit B2B day pushed forecast 30→90/day. At real 30/day, 400 on hand = 13d | INVESTIGATE/ESCALATE/REJECT, ≤120 units |
| 2 | `s2-alternate-supplier` | PO 500 → supplier can do 250. 90 on hand, 45/day ⇒ stockout day 8. Metro (LT 2d, 96% fill) vs BudgetMart (cheaper, LT 8d, 72% fill) | accept 250 + ~200 from Metro; no stockout through day 10 |
| 2 | `s2-inventory-sufficient` | 600 on hand + 250 at 25/day = 34d | accept partial only, 0 new units |
| 2 | `s2-no-good-alternative` | Infant formula on allocation (60 of 200); only alternate has 12d lead time | accept 60 + ESCALATE |
| 2 | `s2-feedback-loop` | As `s2-alternate-supplier`, but Metro's catalogue says 800 while it really confirms only 100 | verification catches it → re-plan (e.g. +100 from QuickSupply) or escalate |
| 3 | `s3-sustained-spike` | Sales rose for 10 days to ~90/day (heatwave note), forecast still 40. Forecast-based need = 0 (the trap); run-rate need = **480** | MODIFY on run-rate, 360–1100 units |
| 3 | `s3-promo-spike` | 2.5× sales explained by a buy-2-get-1 promo that ended yesterday | NO_CHANGE |
| 4 | `s4-budget` | Correct need 1,060 units (₹4.77L) but only ₹2L budget left | buy ≤ 440 (fits budget, needs approval) + ESCALATE for budget |
| 4 | `s4-storage` | Frozen zone has 400 units free for this SKU; rec 800 | ≤ 310 on first delivery, optional split delivery later |

## Baseline

`npm run eval:baseline` runs a **naive blind executor** (accept the recommendation, accept the partial quantity, ignore demand alerts) through the same orchestrator, guardrails and grader. It passes **0 / 12** (see `server/eval-results/latest-baseline.md`). Two things are worth noticing in that report:

- *Constraints* passes everywhere for the baseline, because guardrails block unsafe plans no matter who proposes them. That is the safety layer working independently of the model.
- *Decision / action* still fail: guardrails can stop a bad PO but cannot make a good decision (e.g. `s1-forecast-anomaly` — 800 units is perfectly "legal" and still wrong). That's what the agent is for, and what the evaluation measures.

## Running it

```bash
npm run eval                                   # Gemini agent, all scenarios
npm run eval -- --scenario s2-feedback-loop    # one scenario
npm run eval -- --trials 3                     # repeat to measure consistency (pass^k)
npm run eval:baseline                          # naive baseline, no API key needed
npm test                                       # deterministic unit tests (no API key needed)
```

Reports are written to `server/eval-results/latest-<agent>.{json,md}` and shown on the Evaluation page.

## Two layers of testing

1. **Unit tests (`server/test`)** — deterministic, no network. They pin the planning math, every guardrail, the verifier, and the orchestrator's control flow using a `ScriptedClient` (a fake LLM that plays a script): guardrail-block → corrected plan, buyer rejection → revised plan, supplier under-delivery → verification failure → follow-up plan, and bounded retries → system escalation.
2. **Scenario evals (`npm run eval`)** — the real model on the 12 scenarios, graded against ground truth. LLMs are non-deterministic, so use `--trials N` and compare pass rates rather than single runs.

## Limits of this evaluation (honest notes)

- Ground-truth ranges are hand-derived; they encode one reasonable buying policy, not the only one.
- The explanation check is keyword-based. An LLM-as-judge rubric would grade reasoning quality better, but adds cost and its own variance; I kept the grader fully deterministic.
- 12 scenarios × 1 trial is a smoke test, not a benchmark. The structure (fixture + expectations) makes adding cases cheap — the natural next step is generating perturbed variants of each scenario (different stock levels, lead times) to test robustness.
