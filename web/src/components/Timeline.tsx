import type { RunEvent } from "../types";
import { JsonToggle } from "./ui";

const ICON: Record<string, string> = {
  task: "📥",
  llm: "💭",
  tool_call: "🔧",
  plan_submitted: "📝",
  guardrail: "🛡️",
  approval_requested: "✋",
  approval_resolved: "👤",
  execution: "⚙️",
  verification: "🔍",
  feedback: "🔁",
  final: "🏁",
  error: "⛔",
};

const PHASE: Record<string, string> = {
  task: "Trigger",
  llm: "Reasoning",
  tool_call: "Investigate",
  plan_submitted: "Decide",
  guardrail: "Guardrails",
  approval_requested: "Approval",
  approval_resolved: "Approval",
  execution: "Execute",
  verification: "Verify",
  feedback: "Re-plan",
  final: "Done",
  error: "Error",
};

export function Timeline({ events, start }: { events: RunEvent[]; start: number }) {
  return (
    <ol className="relative space-y-2 border-l border-stone-200 pl-4">
      {events.map((e) => {
        const bad =
          (e.type === "guardrail" && e.data && e.data.ok === false) ||
          (e.type === "verification" && e.data && e.data.ok === false) ||
          e.type === "error";
        return (
          <li key={e.seq} className="relative">
            <span className="absolute -left-[26px] top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-white text-xs">{ICON[e.type] ?? "•"}</span>
            <div className="flex items-baseline gap-2">
              <span className="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-stone-400">{PHASE[e.type] ?? e.type}</span>
              <span className={`text-sm ${bad ? "font-medium text-rose-700" : "text-stone-800"}`}>
                {e.type === "tool_call" ? <span className="font-mono text-xs">{e.title}({argPreview(e.data?.args)})</span> : e.title}
              </span>
              <span className="ml-auto shrink-0 text-[10px] tabular-nums text-stone-400">+{((e.ts - start) / 1000).toFixed(1)}s</span>
            </div>
            {e.type === "llm" && e.data?.text && e.data.text.length > 200 && (
              <p className="mt-1 whitespace-pre-wrap text-xs text-stone-600" style={{ paddingLeft: "5.5rem" }}>
                {e.data.text}
              </p>
            )}
            {["tool_call", "guardrail", "execution", "verification", "feedback", "plan_submitted"].includes(e.type) && (
              <div style={{ paddingLeft: "5.5rem" }}>
                <JsonToggle value={e.type === "tool_call" ? e.data?.result : e.data} label={e.type === "tool_call" ? "result" : "data"} />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function argPreview(args: Record<string, unknown> | undefined) {
  if (!args) return "";
  const s = Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(", ");
  return s.length > 90 ? s.slice(0, 90) + "…" : s;
}
