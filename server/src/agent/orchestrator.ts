/**
 * Agent orchestrator — an explicit state machine around the LLM:
 *
 *   INVESTIGATE (LLM + read-only tools, ReAct loop)
 *        │ submit_plan
 *        ▼
 *   GUARDRAILS (deterministic policy) ──BLOCK──► back to LLM with violations
 *        │ ok
 *        ▼
 *   APPROVAL GATE (human, only if policy says so) ──rejected──► back to LLM with buyer comment
 *        │ approved / not needed
 *        ▼
 *   EXECUTE (PO service + mock supplier API)
 *        ▼
 *   VERIFY (independent read-back + projection vs the agent's expected outcome)
 *        │ deviation                                  │ ok
 *        ▼                                            ▼
 *   back to LLM with observed outcome (re-plan)     DONE
 *
 * Every loop is bounded; when a budget is exhausted the system escalates to a human.
 */
import { config } from "../config.js";
import { executePlan, verifyOutcome } from "../domain/execution.js";
import { PlanSchema, type Plan } from "../domain/plan.js";
import { evaluatePlan, planToProjection, type TaskContext } from "../domain/policy.js";
import { projectInventory } from "../domain/planning.js";
import { World } from "../domain/world.js";
import type { Scenario } from "../scenarios/types.js";
import type { LLMClient, Message } from "./llm.js";
import { systemPrompt, taskPrompt } from "./prompts.js";
import type { ApprovalDecision, Run, RunStore } from "./runs.js";
import { runTool, TOOL_SPECS } from "./tools.js";

export type Approver = (run: Run, plan: Plan, reasons: string[]) => Promise<ApprovalDecision>;

export interface RunOptions {
  maxLlmSteps?: number;
  maxReplans?: number;
  maxGuardrailRejections?: number;
}

const truncate = (v: unknown, n = 6000) => {
  const s = JSON.stringify(v);
  return s.length > n ? JSON.parse(JSON.stringify({ truncated: true, preview: s.slice(0, n) })) : v;
};

export async function runAgent(
  scenario: Scenario,
  llm: LLMClient,
  store: RunStore,
  approver: Approver,
  opts: RunOptions = {},
  existingRun?: Run,
): Promise<Run> {
  const maxSteps = opts.maxLlmSteps ?? config.maxLlmSteps;
  const maxReplans = opts.maxReplans ?? config.maxReplans;
  const maxRejections = opts.maxGuardrailRejections ?? config.maxGuardrailRejections;

  const run = existingRun ?? store.create(scenario.id, llm.name);
  const world = new World(scenario.world);
  run.worldBefore = world.snapshot();
  const task: TaskContext = scenario.trigger.context;
  const started = Date.now();

  const system = systemPrompt(world.policy);
  const history: Message[] = [{ role: "user", text: taskPrompt(scenario) }];
  store.emit(run, "task", scenario.trigger.message, { trigger: scenario.trigger });

  const finish = (status: Run["status"], title: string, data?: unknown) => {
    run.status = status;
    run.finishedAt = Date.now();
    run.metrics.durationMs = run.finishedAt - started;
    run.worldAfter = world.snapshot();
    const lastPlan = run.plans.at(-1)?.plan;
    const dailyDemand = lastPlan ? planToProjection(world, lastPlan, task).dailyDemand : undefined;
    run.initialProjection = projectInventory(new World(run.worldBefore!), task.sku, task.nodeId, { dailyDemand });
    run.finalProjection = projectInventory(world, task.sku, task.nodeId, { dailyDemand });
    store.emit(run, "final", title, data);
    store.update(run);
    return run;
  };

  const systemEscalate = (reason: string) => {
    world.state.escalations.push({
      id: world.nextId("ESC"),
      kind: "ESCALATION",
      sku: task.sku,
      nodeId: task.nodeId,
      reason: `[system] ${reason}`,
      questionForBuyer: "Agent could not complete this task autonomously. Please review the trace and decide.",
      createdDay: world.today,
      runId: run.id,
    });
  };

  let nudges = 0;
  try {
    for (let step = 0; step < maxSteps; step++) {
      const turn = await llm.generate(system, history, TOOL_SPECS);
      run.metrics.llmCalls++;
      run.metrics.inputTokens += turn.usage?.inputTokens ?? 0;
      run.metrics.outputTokens += turn.usage?.outputTokens ?? 0;
      history.push({ role: "model", text: turn.text, calls: turn.calls, raw: turn.raw });
      if (turn.text) store.emit(run, "llm", turn.text.slice(0, 200), { text: turn.text });

      if (!turn.calls.length) {
        // The agent stopped talking without acting. If a verified plan exists we're done.
        const last = run.plans.at(-1);
        if (last?.verification?.ok) return finish("COMPLETED", "Agent finished", { decision: last.plan.decision });
        if (++nudges > 2) {
          systemEscalate("agent stopped without submitting a plan");
          return finish("ESCALATED", "Agent did not submit a plan — escalated to buyer");
        }
        history.push({ role: "user", text: "Continue: use the tools to investigate, then call submit_plan to act. Do not answer in free text only." });
        continue;
      }

      const results: { id?: string; name: string; response: unknown }[] = [];
      const submits = turn.calls.filter((c) => c.name === "submit_plan");

      // 1) run investigation tools
      for (const call of turn.calls.filter((c) => c.name !== "submit_plan")) {
        const response = runTool(call.name, call.args, { world, task });
        run.metrics.toolCalls++;
        run.toolCalls.push({ name: call.name, args: call.args });
        store.emit(run, "tool_call", call.name, { args: call.args, result: response });
        results.push({ id: call.id, name: call.name, response: truncate(response) });
      }
      for (const extra of submits.slice(1)) {
        results.push({ id: extra.id, name: extra.name, response: { error: "Only one submit_plan per turn is allowed; this one was ignored." } });
      }

      // 2) handle the plan (if any) — the whole guardrail → approval → execute → verify
      //    pipeline runs here and its outcome becomes the submit_plan tool response.
      const submit = submits[0];
      if (!submit) {
        history.push({ role: "tool", results });
        continue;
      }
      run.toolCalls.push({ name: "submit_plan", args: submit.args });

      const parsed = PlanSchema.safeParse(submit.args);
      if (!parsed.success) {
        run.metrics.guardrailRejections++;
        store.emit(run, "guardrail", "Plan rejected: invalid schema", { issues: parsed.error.issues });
        results.push({ id: submit.id, name: "submit_plan", response: { status: "INVALID_PLAN", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } });
        history.push({ role: "tool", results });
        if (run.metrics.guardrailRejections > maxRejections) {
          systemEscalate("agent repeatedly produced invalid plans");
          return finish("ESCALATED", "Too many invalid plans — escalated to buyer");
        }
        continue;
      }
      const plan = parsed.data;
      const attempt = run.plans.length + 1;
      store.emit(run, "plan_submitted", `Plan #${attempt}: ${plan.decision}`, plan);

      // ---- GUARDRAILS -------------------------------------------------------
      const g = evaluatePlan(world, plan, task);
      const record: Run["plans"][number] = {
        attempt,
        plan,
        guardrail: { ok: g.ok, requiresApproval: g.requiresApproval, findings: g.findings, budgetImpact: g.budgetImpact },
      };
      run.plans.push(record);
      store.emit(run, "guardrail", g.ok ? (g.requiresApproval ? "Guardrails passed — approval required" : "Guardrails passed") : "Guardrails BLOCKED the plan", record.guardrail);

      if (!g.ok) {
        run.metrics.guardrailRejections++;
        results.push({
          id: submit.id,
          name: "submit_plan",
          response: {
            status: "BLOCKED_BY_GUARDRAILS",
            violations: g.findings.filter((f) => f.severity === "BLOCK"),
            otherFindings: g.findings.filter((f) => f.severity !== "BLOCK"),
            instruction: "Nothing was executed. Revise the plan (use simulate_plan to test it) and call submit_plan again, or escalate.",
          },
        });
        history.push({ role: "tool", results });
        store.update(run);
        if (run.metrics.guardrailRejections > maxRejections) {
          systemEscalate(`plan blocked by guardrails ${run.metrics.guardrailRejections} times`);
          return finish("ESCALATED", "Guardrail retry budget exhausted — escalated to buyer");
        }
        continue;
      }

      // ---- APPROVAL GATE ----------------------------------------------------
      if (g.requiresApproval) {
        const reasons = g.findings.filter((f) => f.severity === "APPROVAL").map((f) => f.message);
        run.status = "AWAITING_APPROVAL";
        run.pendingApproval = { planIndex: run.plans.length - 1, plan, findings: g.findings };
        store.emit(run, "approval_requested", "Waiting for buyer approval", { reasons });
        store.update(run);
        const decision = await approver(run, plan, reasons);
        run.pendingApproval = undefined;
        run.status = "RUNNING";
        record.approval = decision;
        store.emit(run, "approval_resolved", decision.approved ? `Approved by ${decision.by}` : `Rejected by ${decision.by}`, decision);
        if (!decision.approved) {
          run.metrics.replans++;
          results.push({
            id: submit.id,
            name: "submit_plan",
            response: {
              status: "REJECTED_BY_BUYER",
              buyerComment: decision.comment ?? "(no comment)",
              instruction: "Nothing was executed. Take the buyer's feedback into account and submit a revised plan, or escalate.",
            },
          });
          history.push({ role: "tool", results });
          if (run.metrics.replans > maxReplans) return finish("REJECTED_BY_BUYER", "Buyer rejected the plan");
          continue;
        }
      }

      // ---- EXECUTE ------------------------------------------------------------
      const exec = executePlan(world, plan, task, run.id);
      record.execution = exec;
      store.emit(run, "execution", `Executed ${exec.length} action(s)`, exec);

      // ---- VERIFY -------------------------------------------------------------
      const v = verifyOutcome(world, plan, task, exec);
      record.verification = v;
      store.emit(run, "verification", v.ok ? "Verification passed" : "Verification found deviations", { ok: v.ok, checks: v.checks });
      store.update(run);

      if (v.ok) {
        return finish("COMPLETED", `Done: ${plan.decision}`, { decision: plan.decision, summary: plan.summary });
      }

      run.metrics.replans++;
      if (run.metrics.replans > maxReplans) {
        systemEscalate("verification still failing after maximum re-plans: " + v.checks.filter((c) => !c.passed).map((c) => c.detail).join("; "));
        return finish("COMPLETED_WITH_ISSUES", "Re-plan budget exhausted — escalated to buyer", { failed: v.checks.filter((c) => !c.passed) });
      }
      const failed = v.checks.filter((c) => !c.passed);
      store.emit(run, "feedback", "Feeding observed outcome back to the agent", { failed });
      results.push({
        id: submit.id,
        name: "submit_plan",
        response: {
          status: "EXECUTED_WITH_DEVIATIONS",
          execution: exec,
          failedChecks: failed,
          projectionAfterExecution: {
            firstStockoutDay: v.projection.firstStockoutDay,
            daysOfCoverTotal: v.projection.daysOfCoverTotal,
            demandBasis: v.projection.demandBasis,
          },
          instruction:
            "The actions above WERE executed (do not repeat them). The real outcome differs from your expectation. Investigate and submit a follow-up plan with only the additional actions needed, or escalate if nothing compliant is possible.",
        },
      });
      history.push({ role: "tool", results });
    }

    systemEscalate("LLM step budget exhausted");
    return finish("ESCALATED", "Step budget exhausted — escalated to buyer");
  } catch (e) {
    run.error = (e as Error).message;
    store.emit(run, "error", "Run failed", { message: run.error });
    return finish("FAILED", `Run failed: ${run.error}`);
  }
}
