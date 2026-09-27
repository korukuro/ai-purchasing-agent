// Minimal mirror of the server's API shapes (kept loose on purpose).

export interface ScenarioSummary {
  id: string;
  assignmentScenario: 1 | 2 | 3 | 4;
  title: string;
  description: string;
  trigger: { kind: string; message: string; context: { sku: string; nodeId: string; recommendationId?: string; poId?: string } };
  product: { sku: string; name: string; category: string; storageZone: string; shelfLifeDays: number | null; criticality: string };
  onHand: number;
  openPOs: number;
  forecastPerDay: number;
}

export interface Finding {
  code: string;
  severity: "BLOCK" | "APPROVAL" | "INFO";
  message: string;
}

export interface PlanAction {
  type: string;
  reason: string;
  supplierId?: string;
  quantity?: number;
  deliveryDay?: number;
  poId?: string;
  questionForBuyer?: string;
}

export interface Plan {
  decision: string;
  summary: string;
  keyFactors: { factor: string; evidence: string; impact: string }[];
  demandAssumption?: { dailyRate: number; basis: string };
  actions: PlanAction[];
  expectedOutcome?: { noStockoutThroughDay?: number; maxDaysOfCover?: number; notes?: string };
  confidence: number;
  openQuestions: string[];
}

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export interface Projection {
  demandBasis: string;
  firstStockoutDay: number | null;
  daysOfCoverTotal: number;
  peakStock: number;
  storage: { freeCapacityForThisSku: number; exceedsCapacity: boolean; zone: string };
  days: { day: number; demand: number; arrivals: number; closingStock: number; lostSales: number }[];
}

export interface PlanRecord {
  attempt: number;
  plan: Plan;
  guardrail: { ok: boolean; requiresApproval: boolean; findings: Finding[]; budgetImpact: number };
  approval?: { approved: boolean; by: string; comment?: string };
  execution?: { actionIndex: number; type: string; ok: boolean; poId?: string; message: string; expected?: any; actual?: any }[];
  verification?: { ok: boolean; checks: Check[] };
}

export interface RunEvent {
  seq: number;
  ts: number;
  type: string;
  title: string;
  data?: any;
}

export interface Dimension {
  key: string;
  label: string;
  status: "PASS" | "FAIL" | "N/A";
  details: string[];
}

export interface Grade {
  scenarioId: string;
  runId: string;
  agent: string;
  runStatus: string;
  finalDecision: string;
  newUnits: number;
  passed: boolean;
  score: number;
  dimensions: Dimension[];
  metrics: Run["metrics"];
}

export interface Run {
  id: string;
  scenarioId: string;
  agent: string;
  status: string;
  createdAt: number;
  finishedAt?: number;
  events: RunEvent[];
  plans: PlanRecord[];
  pendingApproval?: { plan: Plan; findings: Finding[] };
  metrics: { llmCalls: number; toolCalls: number; inputTokens: number; outputTokens: number; guardrailRejections: number; replans: number; durationMs: number };
  initialProjection?: Projection;
  finalProjection?: Projection;
  error?: string;
  grade: Grade | null;
}

export interface EvalReport {
  agent: string;
  startedAt: string;
  trials: number;
  grades: Grade[];
  summary: {
    scenarios: number;
    runs: number;
    passRate: number;
    avgScore: number;
    byDimension: Record<string, { pass: number; fail: number; na: number }>;
    avgLlmCalls: number;
    avgToolCalls: number;
    totalTokens: number;
  };
}
