import type { Plan, PlanAction } from "../domain/plan.js";
import type { TaskContext } from "../domain/policy.js";
import type { WorldState } from "../domain/types.js";

export type TriggerKind =
  | "RECOMMENDATION_REVIEW"
  | "SUPPLIER_EXCEPTION"
  | "DEMAND_ALERT"
  | "CONSTRAINED_PURCHASE";

/**
 * Ground truth used ONLY by the evaluator. The agent never sees this.
 * Ranges were derived by hand from the fixture data with the same planning
 * math the tools expose (see docs/evaluation.md for the worked numbers).
 */
export interface Expectations {
  allowedDecisions: Plan["decision"][];
  /** Tools the agent must have called to have "obtained the necessary information". Each inner array = any-of. */
  requiredEvidence: { anyOf: string[]; why: string }[];
  /** Net new units secured for the SKU vs the initial state (sum of effective inbound delta). */
  newUnitsRange: [number, number];
  /** Actual underlying demand (may differ from the system forecast). */
  trueDailyDemand: number;
  /** Using true demand, there must be no stockout through this day (unless the agent escalated). */
  noStockoutThroughDay?: number;
  requiredActionTypes?: PlanAction["type"][];
  mustEscalate?: boolean;
  /** This scenario is designed so the first action fails in execution: the agent must re-plan. */
  expectReplan?: boolean;
  /** Keyword groups; the rationale must mention at least one keyword of each group. */
  rationaleMentions?: string[][];
}

export interface Scenario {
  id: string;
  assignmentScenario: 1 | 2 | 3 | 4;
  title: string;
  description: string; // for humans (UI / README)
  trigger: { kind: TriggerKind; message: string; context: TaskContext };
  world: WorldState;
  expectations: Expectations;
}
