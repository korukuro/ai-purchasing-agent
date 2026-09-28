import { EventEmitter } from "node:events";
import type { ActionResult, VerificationResult } from "../domain/execution.js";
import type { Plan } from "../domain/plan.js";
import type { Finding } from "../domain/policy.js";
import type { projectInventory } from "../domain/planning.js";
import type { WorldState } from "../domain/types.js";

export type RunStatus =
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "COMPLETED" // plan executed (or nothing to execute) and verification passed
  | "COMPLETED_WITH_ISSUES" // verification still failing after max re-plans -> auto-escalated
  | "ESCALATED" // agent could not produce a compliant plan -> auto-escalated
  | "REJECTED_BY_BUYER"
  | "FAILED";

export type EventType =
  | "task"
  | "llm"
  | "tool_call"
  | "plan_submitted"
  | "guardrail"
  | "approval_requested"
  | "approval_resolved"
  | "execution"
  | "verification"
  | "feedback"
  | "final"
  | "error";

export interface RunEvent {
  seq: number;
  ts: number;
  type: EventType;
  title: string;
  data?: unknown;
}

export interface PlanRecord {
  attempt: number;
  plan: Plan;
  guardrail: { ok: boolean; requiresApproval: boolean; findings: Finding[]; budgetImpact: number };
  approval?: { approved: boolean; by: string; comment?: string };
  execution?: ActionResult[];
  verification?: VerificationResult;
}

export interface ApprovalDecision {
  approved: boolean;
  by: string;
  comment?: string;
}

export interface Run {
  id: string;
  scenarioId: string;
  agent: string;
  status: RunStatus;
  createdAt: number;
  finishedAt?: number;
  events: RunEvent[];
  plans: PlanRecord[];
  pendingApproval?: { planIndex: number; plan: Plan; findings: Finding[] };
  toolCalls: { name: string; args: unknown }[];
  metrics: { llmCalls: number; toolCalls: number; inputTokens: number; outputTokens: number; guardrailRejections: number; replans: number; durationMs: number };
  initialProjection?: ReturnType<typeof projectInventory>;
  finalProjection?: ReturnType<typeof projectInventory>;
  worldBefore?: WorldState;
  worldAfter?: WorldState;
  error?: string;
}

/** In-memory run registry with pub/sub for live (SSE) streaming to the UI. */
export class RunStore {
  private runs = new Map<string, Run>();
  private bus = new EventEmitter();
  private approvals = new Map<string, (d: ApprovalDecision) => void>();
  private seq = 1;

  /** @param onAnyEvent optional listener for every event of every run (used by the eval CLI for live progress) */
  constructor(private onAnyEvent?: (run: Run, ev: RunEvent) => void) {
    this.bus.setMaxListeners(100);
  }

  create(scenarioId: string, agent: string): Run {
    const id = `run-${Date.now().toString(36)}-${(this.seq++).toString(36)}`;
    const run: Run = {
      id,
      scenarioId,
      agent,
      status: "RUNNING",
      createdAt: Date.now(),
      events: [],
      plans: [],
      toolCalls: [],
      metrics: { llmCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, guardrailRejections: 0, replans: 0, durationMs: 0 },
    };
    this.runs.set(id, run);
    return run;
  }

  get(id: string) {
    return this.runs.get(id);
  }

  list() {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  emit(run: Run, type: EventType, title: string, data?: unknown) {
    const ev: RunEvent = { seq: run.events.length + 1, ts: Date.now(), type, title, data };
    run.events.push(ev);
    this.bus.emit(run.id, ev);
    this.onAnyEvent?.(run, ev);
  }

  update(run: Run) {
    this.bus.emit(`${run.id}:update`, run);
  }

  subscribe(runId: string, onEvent: (e: RunEvent) => void, onUpdate: (r: Run) => void) {
    this.bus.on(runId, onEvent);
    this.bus.on(`${runId}:update`, onUpdate);
    return () => {
      this.bus.off(runId, onEvent);
      this.bus.off(`${runId}:update`, onUpdate);
    };
  }

  waitForApproval(runId: string): Promise<ApprovalDecision> {
    return new Promise((resolve) => this.approvals.set(runId, resolve));
  }

  resolveApproval(runId: string, d: ApprovalDecision): boolean {
    const r = this.approvals.get(runId);
    if (!r) return false;
    this.approvals.delete(runId);
    r(d);
    return true;
  }
}
