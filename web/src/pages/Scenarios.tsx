import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import type { Health } from "../App";
import type { ScenarioSummary } from "../types";
import { Badge } from "../components/ui";

const GROUPS: Record<number, string> = {
  1: "Scenario 1 — Purchase recommendation review",
  2: "Scenario 2 — Supplier cannot fulfil the purchase",
  3: "Scenario 3 — Demand / forecast has changed",
  4: "Scenario 4 — Purchasing constraint",
};

export default function ScenariosPage({ health }: { health: Health | null }) {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [approvalMode, setApprovalMode] = useState<"manual" | "auto">("manual");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    api.get<ScenarioSummary[]>("/api/scenarios").then(setScenarios).catch((e) => setError(e.message));
  }, []);

  const start = async (scenarioId: string, agent: "gemini" | "baseline") => {
    setBusy(`${scenarioId}:${agent}`);
    setError(null);
    try {
      const { runId } = await api.post<{ runId: string }>("/api/runs", { scenarioId, agent, approvalMode });
      nav(`/runs/${runId}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-3xl">
          <h1 className="text-xl font-bold text-stone-900">Purchasing situations</h1>
          <p className="mt-1 text-sm text-stone-600">
            Each scenario is an isolated mock world (inventory, demand, open POs, suppliers, budget, storage). Run the AI agent to watch it investigate,
            decide, pass guardrails, get approval when required, execute against the mock supplier system and verify the result.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-stone-700">
          Buyer approvals:
          <select className="rounded-md border border-stone-300 bg-white px-2 py-1 text-sm" value={approvalMode} onChange={(e) => setApprovalMode(e.target.value as "manual" | "auto")}>
            <option value="manual">I approve manually</option>
            <option value="auto">Auto-approve (demo)</option>
          </select>
        </label>
      </div>
      {error && <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</div>}

      {[1, 2, 3, 4].map((g) => (
        <section key={g}>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-stone-500">{GROUPS[g]}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {scenarios
              .filter((s) => s.assignmentScenario === g)
              .map((s) => (
                <article key={s.id} className="flex flex-col rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-semibold text-stone-900">{s.title}</h3>
                    <span className="font-mono text-[11px] text-stone-400">{s.id}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                    <Badge>{s.product.name}</Badge>
                    <Badge>{s.product.storageZone}</Badge>
                    {s.product.shelfLifeDays && s.product.shelfLifeDays < 30 && <Badge>shelf life {s.product.shelfLifeDays}d</Badge>}
                    {s.product.criticality === "high" && <Badge tone="ESCALATE">high criticality</Badge>}
                  </div>
                  <p className="mt-2 text-sm text-stone-600">{s.description}</p>
                  <div className="mt-3 rounded-md bg-stone-50 px-3 py-2 text-xs text-stone-700">
                    <span className="font-semibold">Trigger:</span> {s.trigger.message}
                  </div>
                  <div className="mt-3 flex items-center gap-4 text-xs text-stone-500">
                    <span>on hand {s.onHand}</span>
                    <span>open POs {s.openPOs}</span>
                    <span>forecast {s.forecastPerDay}/day</span>
                  </div>
                  <div className="mt-4 flex gap-2">
                    <button
                      disabled={!health?.llmConfigured || busy !== null}
                      onClick={() => start(s.id, "gemini")}
                      className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busy === `${s.id}:gemini` ? "Starting…" : "Run AI agent"}
                    </button>
                    <button
                      disabled={busy !== null}
                      onClick={() => start(s.id, "baseline")}
                      className="rounded-md border border-stone-300 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-100 disabled:opacity-40"
                      title="Naive blind executor: does what the trigger says without investigating"
                    >
                      Run naive baseline
                    </button>
                  </div>
                </article>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
