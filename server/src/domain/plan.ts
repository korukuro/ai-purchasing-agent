import { z } from "zod";

/**
 * A Plan is the ONLY way the LLM can change the world. It is a structured
 * proposal that goes through: guardrails -> (human approval) -> execution ->
 * verification. The LLM never writes to the system of record directly.
 */

export const DECISIONS = ["ACCEPT", "MODIFY", "REJECT", "INVESTIGATE", "ESCALATE", "NO_CHANGE"] as const;
export const ACTION_TYPES = [
  "CREATE_PO",
  "UPDATE_PO_QTY",
  "CANCEL_PO",
  "ACCEPT_PARTIAL",
  "ESCALATE",
] as const;

const num = z.coerce.number();

export const ActionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  reason: z.string().default(""),
  // CREATE_PO
  supplierId: z.string().optional(),
  sku: z.string().optional(),
  nodeId: z.string().optional(),
  quantity: num.optional(),
  deliveryDay: num.optional(), // optional scheduled arrival (>= supplier lead time)
  // UPDATE_PO_QTY / CANCEL_PO / ACCEPT_PARTIAL
  poId: z.string().optional(),
  // ESCALATE
  questionForBuyer: z.string().optional(),
});
export type PlanAction = z.infer<typeof ActionSchema>;

export const PlanSchema = z.object({
  decision: z.enum(DECISIONS),
  summary: z.string().min(1),
  keyFactors: z
    .array(
      z.object({
        factor: z.string(),
        evidence: z.string().default(""),
        impact: z.string().default(""),
      }),
    )
    .default([]),
  demandAssumption: z
    .object({ dailyRate: num, basis: z.string().default("") })
    .optional(),
  actions: z.array(ActionSchema).default([]),
  expectedOutcome: z
    .object({
      noStockoutThroughDay: num.optional(),
      maxDaysOfCover: num.optional(),
      notes: z.string().optional(),
    })
    .optional(),
  confidence: num.min(0).max(1).default(0.5),
  openQuestions: z.array(z.string()).default([]),
});
export type Plan = z.infer<typeof PlanSchema>;

export const PO_MUTATING: PlanAction["type"][] = ["CREATE_PO", "UPDATE_PO_QTY", "CANCEL_PO"];
