import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import type { Run, RunEvent } from "../types";
import { Badge, Card, PassFail, Stat } from "../components/ui";
import { Timeline } from "../components/Timeline";
import { Findings, PlanBody, PlanHistory } from "../components/PlanView";
import { ProjectionChart } from "../components/ProjectionChart";

export default function RunPage() {
  const { id } = useParams();
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [comment, setComment] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setEvents([]);
    const es = new EventSource(`/api/runs/${id}/stream`);
    es.addEventListener("event", (m) => {
      const ev = JSON.parse((m as MessageEvent).data) as RunEvent;
      setEvents((prev) => (prev.some((p) => p.seq === ev.seq) ? prev : [...prev, ev]));
    });
    es.addEventListener("run", (m) => setRun(JSON.parse((m as MessageEvent).data)));
    es.onerror = () => {
      // fall back to a plain fetch if the stream drops
      api.get<Run>(`/api/runs/${id}`).then((r) => {
        setRun(r);
        setEvents(r.events);
      }).catch(() => setErr("Run not found (the server keeps runs in memory — it may have restarted)."));
    };
    return () => es.close();
  }, [id]);

  const decide = async (approved: boolean) => {
    try {
      await api.post(`/api/runs/${id}/approval`, { approved, comment: comment || undefined });
      setComment("");
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (err) return <div className="rounded-md bg-rose-50 p-3 text-sm text-rose-800">{err}</div>;
  if (!run) return <div className="text-sm text-stone-500">Loading run…</div>;

  const lastExecuted = [...run.plans].reverse().find((p) => p.execution);
  const running = run.status === "RUNNING" || run.status === "AWAITING_APPROVAL";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/" className="text-sm text-blue-700 hover:underline">← Scenarios</Link>
        <h1 className="text-lg font-bold text-stone-900">{run.scenarioId}</h1>
        <Badge tone={run.status}>{run.status.replaceAll("_", " ")}</Badge>
        <span className="text-xs text-stone-500">agent: {run.agent}</span>
        {running && <span className="animate-pulse text-xs text-blue-700">working…</span>}
      </div>

      <div className="grid grid-cols-2 gap-4 rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="LLM calls" value={run.metrics.llmCalls} />
        <Stat label="Tool calls" value={run.metrics.toolCalls} />
        <Stat label="Guardrail blocks" value={run.metrics.guardrailRejections} />
        <Stat label="Re-plans" value={run.metrics.replans} />
        <Stat label="Tokens" value={(run.metrics.inputTokens + run.metrics.outputTokens).toLocaleString()} />
        <Stat label="Duration" value={run.finishedAt ? `${((run.finishedAt - run.createdAt) / 1000).toFixed(1)}s` : "…"} />
      </div>

      {run.status === "AWAITING_APPROVAL" && run.pendingApproval && (
        <Card title="✋ Buyer approval required" className="border-amber-300 bg-amber-50/40">
          <Findings findings={run.pendingApproval.findings.filter((f) => f.severity !== "INFO")} />
          <div className="mt-3 rounded-lg border border-amber-200 bg-white p-3">
            <PlanBody plan={run.pendingApproval.plan} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Optional comment (sent back to the agent if you reject)"
              className="min-w-64 flex-1 rounded-md border border-stone-300 px-2 py-1.5 text-sm"
            />
            <button onClick={() => decide(true)} className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600">Approve & execute</button>
            <button onClick={() => decide(false)} className="rounded-md bg-rose-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-600">Reject</button>
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          {run.initialProjection && run.finalProjection && (
            <Card title="Projected stock (next 21 days)">
              <ProjectionChart before={run.initialProjection} after={run.finalProjection} />
            </Card>
          )}
          <Card title="Agent trace">
            <Timeline events={events} start={run.createdAt} />
          </Card>
        </div>
        <div className="space-y-4 lg:col-span-2">
          {lastExecuted && (
            <Card title="Final decision">
              <PlanBody plan={lastExecuted.plan} />
            </Card>
          )}
          {run.grade && (
            <Card title="Evaluation against ground truth" right={<span className="text-sm font-semibold">{run.grade.passed ? "✅ passed" : "❌ failed"}</span>}>
              <ul className="space-y-2 text-sm">
                {run.grade.dimensions.map((d) => (
                  <li key={d.key}>
                    <div className="flex justify-between gap-2">
                      <span className="text-stone-800">{d.label}</span>
                      <PassFail status={d.status} />
                    </div>
                    <div className="text-xs text-stone-500">{d.details.join("; ")}</div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {run.plans.length > 0 && (
            <Card title={`Plans, guardrails & verification (${run.plans.length})`}>
              <PlanHistory plans={run.plans} />
            </Card>
          )}
          {run.error && <Card title="Error"><div className="text-sm text-rose-700">{run.error}</div></Card>}
        </div>
      </div>
    </div>
  );
}
