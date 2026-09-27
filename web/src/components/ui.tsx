import { useState, type ReactNode } from "react";

const DECISION_STYLES: Record<string, string> = {
  ACCEPT: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  MODIFY: "bg-blue-50 text-blue-800 ring-blue-200",
  REJECT: "bg-rose-50 text-rose-800 ring-rose-200",
  INVESTIGATE: "bg-amber-50 text-amber-800 ring-amber-200",
  ESCALATE: "bg-amber-50 text-amber-900 ring-amber-300",
  NO_CHANGE: "bg-stone-100 text-stone-700 ring-stone-200",
};

const STATUS_STYLES: Record<string, string> = {
  RUNNING: "bg-blue-50 text-blue-800 ring-blue-200",
  AWAITING_APPROVAL: "bg-amber-50 text-amber-900 ring-amber-300",
  COMPLETED: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  COMPLETED_WITH_ISSUES: "bg-amber-50 text-amber-900 ring-amber-300",
  ESCALATED: "bg-amber-50 text-amber-900 ring-amber-300",
  REJECTED_BY_BUYER: "bg-rose-50 text-rose-800 ring-rose-200",
  FAILED: "bg-rose-50 text-rose-800 ring-rose-200",
};

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  const cls = DECISION_STYLES[tone ?? ""] ?? STATUS_STYLES[tone ?? ""] ?? "bg-stone-100 text-stone-700 ring-stone-200";
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${cls}`}>{children}</span>;
}

export function PassFail({ status }: { status: "PASS" | "FAIL" | "N/A" | boolean }) {
  const s = status === true ? "PASS" : status === false ? "FAIL" : status;
  if (s === "PASS") return <span className="font-semibold text-emerald-700">✓ pass</span>;
  if (s === "FAIL") return <span className="font-semibold text-rose-700">✗ fail</span>;
  return <span className="text-stone-400">— n/a</span>;
}

export function Card({ title, children, right, className = "" }: { title?: ReactNode; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-stone-200 bg-white p-4 shadow-sm ${className}`}>
      {title && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-stone-800">{title}</h3>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function JsonToggle({ value, label = "details" }: { value: unknown; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button className="text-xs text-blue-700 hover:underline" onClick={() => setOpen(!open)}>
        {open ? "hide" : "show"} {label}
      </button>
      {open && <pre className="mt-1 max-h-80 overflow-auto rounded-md bg-stone-900 p-2 text-[11px] leading-snug text-stone-100">{JSON.stringify(value, null, 2)}</pre>}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-stone-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-stone-900">{value}</div>
    </div>
  );
}
