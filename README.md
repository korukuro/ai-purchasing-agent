# AI Purchasing Agent

A full-stack agent that takes a purchasing situation at a quick-commerce dark store, investigates it, decides what to do, executes the decision against (mock) purchasing and supplier systems, and **verifies that the result is what it expected**, re-planning or escalating to a human buyer when it isn't.

It is not a chatbot. The model never answers in prose and never writes to the system of record directly. It proposes a structured plan, and deterministic code validates, executes and checks it.

```
trigger ──► investigate (tools) ──► plan ──► guardrails ──► [buyer approval] ──► execute ──► verify ──► done
                 ▲                              │ blocked                                   │ deviation
                 └──────────────────────────────┴───────────── feedback ────────────────────┘
```

- **Stack:** TypeScript end to end: Node + Express API, React + Vite + Tailwind dashboard, Google Gemini (free tier) through a provider-agnostic client
- **All four assignment scenarios** are implemented as 12 test scenarios, with ground truth, a grader and a naive baseline
- **Docs:** [Architecture](docs/architecture.md) · [Evaluation approach](docs/evaluation.md)

---

## Quick start

Requirements: Node.js ≥ 20 and a free Gemini API key from https://aistudio.google.com/apikey

```bash
git clone <this repo> && cd ai-purchasing-agent
npm install
cp .env.example .env          # then set GEMINI_API_KEY=...
npm run check-llm             # one tiny request: verifies key, model and quota
npm run dev                   # API on :8787, dashboard on http://localhost:5173
```

On Windows PowerShell use `copy .env.example .env`.

Other commands:

| Command | What it does |
|---|---|
| `npm test` | 29 unit tests: planning math, guardrails, verifier, orchestrator loops with a scripted LLM, reference solutions for all 12 scenarios, and a Gemini client contract test. No key needed |
| `npm run check-llm` | Verifies the Gemini key/model with one request; on failure explains why and lists the models your key can use |
| `npm run eval` | Runs the Gemini agent on all 12 scenarios and grades it (free tier: ~15–25 min, live progress in the terminal). Saves `server/eval-results/latest-gemini.{json,md}` after every scenario |
| `npm run eval -- --scenario s2-feedback-loop --trials 3` | One scenario, repeated |
| `npm run eval:baseline` | Grades the naive "blind executor" baseline. No key needed |
| `npm run build && npm start` | Production build; the API also serves the dashboard on :8787 |

Without a key, the dashboard still works with the baseline agent, and the tests and baseline eval still run.

### Using the demo

1. **Scenarios** page: pick a situation and click **Run AI agent**. Choose *I approve manually* to act as the buyer.
2. **Run** page, which streams live:
   - the agent trace: every tool call with its result, each plan, the guardrail findings, the supplier responses and the verification checks
   - an approval card when a plan needs a buyer. If you reject with a comment, the agent receives the comment and revises the plan
   - a projected-stock chart comparing no action with the agent's plan (using actual supplier confirmations)
   - the automatic grade against ground truth
3. **Evaluation** page: run the whole suite and see the scenario × dimension scorecard.

`s2-feedback-loop` is the best single demo. The alternate supplier confirms only 100 of the units it advertised. Verification catches the shortfall, the observed outcome goes back to the agent, and the agent tops up the order from a third supplier.

---

## Approach

### 1. Breaking the problem down

A buyer's decision comes down to four questions. The data and tools were designed around them:

| Question | Information | Tool(s) |
|---|---|---|
| What is the real demand? | sales history vs forecast, forecast accuracy, outliers, promotions, ops notes | `get_demand_signals` |
| When do we run out? | on hand, **all** open POs incl. unconfirmed and supplier exceptions | `get_inventory_position`, `get_open_purchase_orders`, `get_purchase_order` |
| What can we buy, from whom? | MOQ, case size, lead time, price, catalogue availability, **reliability history** | `get_supplier_options`, `get_supplier_messages` |
| What are we allowed to do? | budget, storage by zone, shelf life, approval limits, SOP | `get_budget`, `get_product`, `search_buying_policy` |

`get_situation_overview` bundles all of the above into one call. Most scenarios then need only 3–5 LLM turns, which matters on a free-tier quota. The specific tools remain available for drilling down.

Two calculators do the arithmetic, so the LLM never computes quantities in its head:

- `calculate_requirement`: order-up-to need = demand over (lead time + review period) + safety stock − on hand − inbound, rounded to case size and MOQ. It accepts a demand override, so the agent can plan on the recent run-rate instead of a stale forecast.
- `simulate_plan`: a what-if day-by-day projection of a candidate plan, run through the same guardrails that the real submission faces. The agent can test plans before committing to one.

`submit_plan` is the only write path.

### 2. The recommendation is treated as a hypothesis

The scenarios deliberately include recommendations that are wrong in realistic ways:

- a stale snapshot that misses a confirmed PO
- a quantity that isn't a case multiple
- a promotion that isn't in the calendar
- a forecast inflated by a single B2B order
- a correct quantity that doesn't fit the budget or the freezer

The system prompt tells the agent to reconcile every recommendation against current facts before acting on it.

### 3. Decisions and actions

**Decisions:** `ACCEPT`, `MODIFY`, `REJECT`, `INVESTIGATE`, `ESCALATE`, `NO_CHANGE`

**Actions:** `CREATE_PO` (optionally with a later `deliveryDay` for split deliveries), `UPDATE_PO_QTY`, `CANCEL_PO`, `ACCEPT_PARTIAL`, `ESCALATE`

Each plan also carries:

- **key factors**, each with numeric evidence
- the **demand assumption** the plan was built on
- an **expected outcome** (`noStockoutThroughDay`), which is the contract the result is verified against

### 4. Guardrails and human-in-the-loop

`server/src/domain/policy.ts` runs on every plan before anything executes:

| Finding | Examples | Effect |
|---|---|---|
| **BLOCK** | budget exceeded, below MOQ or not a case multiple, above supplier availability, earlier than lead time, freezer overflow, perishable over-cover, inconsistent decision, plan contradicts its own expected outcome | Plan goes back to the agent with the violations. Nothing is executed |
| **APPROVAL** | PO value > ₹1.5L, cancellation, supplier fill rate < 85%, > 25% above recommendation, > 30 days of cover | Run pauses until the buyer approves or rejects |
| **INFO** | residual stockout risk on a high-criticality SKU | Logged in the trace |

The agent acts autonomously only on low-risk, in-policy actions. High-impact ones go to a human. Anything the agent cannot resolve within its retry budgets is escalated automatically.

### 5. Feedback loop and validation

This is the part the brief emphasises, so it has three layers:

1. **Before execution.** Guardrails plus a self-consistency check: if simulating the plan under its own demand assumption shows a stockout before the promised day, the plan is blocked as `PLAN_INCONSISTENT`.
2. **Execution feedback.** The mock supplier API behaves like a real one. It can confirm partially, reject, slip delivery or change the price, and its catalogue can over-promise (hidden `supplierBehavior` in the fixtures).
3. **Independent verification.** The verifier does not trust the executor's return values. It re-reads every PO from the system of record (quantity, arrival, price), re-checks budget and storage, and re-projects stock against the plan's expected outcome.

If anything deviates, the observed outcome goes back to the agent as the `submit_plan` response, marked *"these actions WERE executed, do not repeat them"*. The agent then submits a follow-up plan with only the additional actions needed, or escalates. Loops are bounded: at most 3 guardrail rejections and 2 re-plans, then the system escalates to the buyer.

### 6. Evaluation

Every scenario has hand-derived ground truth (see the [worked numbers](docs/evaluation.md#scenarios-and-worked-numbers)). A deterministic grader scores each run on the seven questions in the brief, using only the trace and the before/after system state:

1. Was the decision correct?
2. Did it obtain the necessary information?
3. Did it respect constraints?
4. Did it take the appropriate action?
5. Did it validate the result?
6. Did it handle a failed action?
7. Did it explain the important factors?

Hand-written reference solutions pass **12/12** (so every scenario is solvable and the grader isn't too strict). The naive baseline goes through the same pipeline and passes **0/12**, which shows the grader discriminates. It also separates what the guardrails guarantee (constraints hold for any agent) from what the agent has to supply (the right decision).

→ Full details, including the limits of this approach: [docs/evaluation.md](docs/evaluation.md)

---

## Project structure

```
server/
  src/
    domain/        types, World (system of record), planning math, plan schema,
                   policy guardrails, mock supplier API, executor + verifier
    agent/         LLM client (Gemini + scripted), tools, prompts, orchestrator, run store, baseline
    scenarios/     12 scenario fixtures + ground-truth expectations
    knowledge/     buying SOP + BM25-style retriever
    eval/          grader, runner, CLI
    api/           Express REST + SSE
  test/            vitest unit tests
  eval-results/    saved evaluation reports
web/
  src/pages/       Scenarios, Run (live trace / approval / chart / grade), Runs, Evaluation
  src/components/  trace timeline, plan view, projection chart, UI bits
docs/              architecture.md, evaluation.md
```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `GEMINI_API_KEY` | none | required for the AI agent |
| `GEMINI_MODEL` | `gemini-flash-latest,gemini-flash-lite-latest` | one model or a comma-separated fallback chain; when a model's free-tier **daily** quota runs out the client switches to the next one |
| `LLM_RPM` | `5` | client-side rate limit shared by all runs, to stay inside the free tier; per-minute 429s are retried with the server's suggested delay |
| `PORT` | `8787` | API port (Vite proxies `/api`) |
| `AGENT_MAX_LLM_STEPS` / `AGENT_MAX_REPLANS` / `AGENT_MAX_GUARDRAIL_REJECTIONS` | 30 / 2 / 3 | loop budgets |

## Trade-offs and what I'd do next

- **In-memory state.** Each run gets an isolated copy of a scenario world. That makes runs reproducible and gradeable. Postgres would sit behind the same `World` methods.
- **Single-SKU tasks.** A real buyer handles hundreds of exceptions every morning. The same orchestrator could run in batch over an exceptions queue, grouping POs per supplier to hit MOQs and truck fills.
- **Transfers between dark stores.** `s2-no-good-alternative` would often be solved by moving stock from a nearby store. Adding `get_network_stock` and a `CREATE_TRANSFER` action is the most valuable next capability.
- **Asynchronous supplier confirmations.** Verification currently runs immediately. In production it would re-trigger when the supplier's confirmation email or EDI message arrives, which the agent would parse the same way it reads supplier messages today.
- **Retrieval.** The SOP retriever is keyword-based over one document. Next would be embeddings over SOPs, contracts and past decision outcomes, so the agent can learn which suppliers actually delivered.
- **Evaluation.** Add perturbed variants of each scenario, repeated trials (pass^k), and an LLM-as-judge rubric for rationale quality alongside the deterministic grader.
