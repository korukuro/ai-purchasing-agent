import type { Check, Finding, Plan, PlanRecord } from "../types";
import { Badge } from "./ui";

export function PlanBody({ plan }: { plan: Plan }) {
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={plan.decision}>{plan.decision}</Badge>
        <span className="text-xs text-stone-500">confidence {Math.round(plan.confidence * 100)}%</span>
        {plan.demandAssumption && (
          <span className="text-xs text-stone-500">
            · planned on {plan.demandAssumption.dailyRate}/day ({plan.demandAssumption.basis})
          </span>
        )}
      </div>
      <p className="text-stone-800">{plan.summary}</p>
      {plan.keyFactors.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">Key factors</div>
          <ul className="space-y-1.5">
            {plan.keyFactors.map((k, i) => (
              <li key={i} className="rounded-md bg-stone-50 px-2.5 py-1.5">
                <span className="font-medium text-stone-900">{k.factor}</span>
                {k.evidence && <span className="text-stone-600"> — {k.evidence}</span>}
                {k.impact && <div className="text-xs text-stone-500">{k.impact}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">Actions</div>
        {plan.actions.length === 0 ? (
          <div className="text-stone-500">No actions (nothing to execute).</div>
        ) : (
          <ol className="space-y-1">
            {plan.actions.map((a, i) => (
              <li key={i} className="flex gap-2">
                <span className="font-mono text-xs text-stone-400">{i + 1}.</span>
                <span>
                  <span className="font-mono text-xs font-semibold text-stone-800">{a.type}</span>{" "}
                  {a.type === "CREATE_PO" && (
                    <>
                      {a.quantity} units from <b>{a.supplierId}</b>
                      {a.deliveryDay !== undefined && ` (deliver day ${a.deliveryDay})`}
                    </>
                  )}
                  {(a.type === "UPDATE_PO_QTY" || a.type === "ACCEPT_PARTIAL") && (
                    <>
                      {a.poId} → {a.quantity ?? "proposed qty"} units
                    </>
                  )}
                  {a.type === "CANCEL_PO" && a.poId}
                  {a.type === "ESCALATE" && <span className="text-amber-900">“{a.questionForBuyer}”</span>}
                  {a.reason && <span className="text-xs text-stone-500"> — {a.reason}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      {plan.expectedOutcome?.noStockoutThroughDay !== undefined && (
        <div className="text-xs text-stone-500">Expected outcome: no stockout through day {plan.expectedOutcome.noStockoutThroughDay}</div>
      )}
    </div>
  );
}

export function Findings({ findings }: { findings: Finding[] }) {
  if (!findings.length) return <div className="text-sm text-emerald-700">No policy findings.</div>;
  const color = { BLOCK: "text-rose-700", APPROVAL: "text-amber-800", INFO: "text-stone-500" };
  return (
    <ul className="space-y-1 text-sm">
      {findings.map((f, i) => (
        <li key={i}>
          <span className={`font-mono text-xs font-semibold ${color[f.severity]}`}>{f.severity}</span>{" "}
          <span className="font-mono text-xs text-stone-500">{f.code}</span> {f.message}
        </li>
      ))}
    </ul>
  );
}

export function Checks({ checks }: { checks: Check[] }) {
  return (
    <ul className="space-y-1 text-sm">
      {checks.map((c, i) => (
        <li key={i} className="flex gap-2">
          <span className={c.passed ? "text-emerald-700" : "text-rose-700"}>{c.passed ? "✓" : "✗"}</span>
          <span>
            <span className="font-medium">{c.name}</span> <span className="text-stone-500">— {c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function PlanHistory({ plans }: { plans: PlanRecord[] }) {
  return (
    <div className="space-y-3">
      {plans.map((p) => (
        <div key={p.attempt} className="rounded-lg border border-stone-200 p-3">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-semibold text-stone-700">Plan #{p.attempt}</span>
            <span className="text-stone-500">
              {!p.guardrail.ok ? "blocked by guardrails" : p.approval ? (p.approval.approved ? `approved by ${p.approval.by}` : `rejected by ${p.approval.by}`) : "auto-approved (within policy)"}
              {p.verification && (p.verification.ok ? " · verified ✓" : " · deviations ✗")}
            </span>
          </div>
          <PlanBody plan={p.plan} />
          <div className="mt-3 border-t border-stone-100 pt-2">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">Guardrails</div>
            <Findings findings={p.guardrail.findings} />
          </div>
          {p.execution && (
            <div className="mt-3 border-t border-stone-100 pt-2">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">Execution (supplier responses)</div>
              <ul className="space-y-1 text-sm">
                {p.execution.map((e, i) => (
                  <li key={i}>
                    <span className={e.ok ? "text-emerald-700" : "text-rose-700"}>{e.ok ? "●" : "●"}</span> <span className="font-mono text-xs">{e.type}</span>
                    {e.poId && <span className="font-mono text-xs text-stone-500"> {e.poId}</span>} — {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {p.verification && (
            <div className="mt-3 border-t border-stone-100 pt-2">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">Verification (independent read-back)</div>
              <Checks checks={p.verification.checks} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
