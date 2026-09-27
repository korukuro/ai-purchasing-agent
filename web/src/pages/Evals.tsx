import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Health } from "../App";
import type { EvalReport } from "../types";
import { Card, Stat } from "../components/ui";

const DIMS = [
  ["decision", "Decision"],
  ["information", "Info"],
  ["constraints", "Constraints"],
  ["action", "Action"],
  ["validation", "Validated"],
  ["recovery", "Recovery"],
  ["explanation", "Explained"],
] as const;

interface Job {
  agent: string;
  running: boolean;
  log: string[];
  error?: string;
}

export default function EvalsPage({ health }: { health: Health | null }) {
  const [agent, setAgent] = useState<"gemini" | "baseline">("gemini");
  const [report, setReport] = useState<EvalReport | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<EvalReport | null>(`/api/evals/${agent}`).then(setReport).catch(() => setReport(null));
  }, [agent]);
  useEffect(load, [load]);

  useEffect(() => {
    if (!job?.running) return;
    const t = setInterval(async () => {
      const j = await api.get<Job | null>("/api/eval-job");
      setJob(j);
      if (j && !j.running) load();
    }, 2000);
    return () => clearInterval(t);
  }, [job?.running, load]);

  const start = async () => {
    setErr(null);
    try {
      await api.post("/api/evals", { agent });
      setJob({ agent, running: true, log: [] });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-3xl">
          <h1 className="text-xl font-bold text-stone-900">Evaluation</h1>
          <p className="mt-1 text-sm text-stone-600">
            Every scenario has hand-derived ground truth (acceptable decisions, quantity range, true demand, required evidence). The grader scores each run
            from the trace and the before/after system state — not from what the agent claims. The naive baseline runs through the same pipeline to show the
            grader discriminates.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm" value={agent} onChange={(e) => setAgent(e.target.value as "gemini" | "baseline")}>
            <option value="gemini">AI agent (Gemini)</option>
            <option value="baseline">Naive baseline</option>
          </select>
          <button
            onClick={start}
            disabled={job?.running || (agent === "gemini" && !health?.llmConfigured)}
            className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-40"
          >
            {job?.running ? "Running…" : "Run evaluation"}
          </button>
        </div>
      </div>
      {err && <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">{err}</div>}
      {job && (job.running || job.error) && (
        <Card title={`Evaluation in progress (${job.agent})`}>
          <pre className="max-h-48 overflow-auto text-xs text-stone-700">{job.log.join("\n") || "starting…"}</pre>
          {job.error && <div className="text-sm text-rose-700">{job.error}</div>}
        </Card>
      )}

      {!report ? (
        <p className="text-sm text-stone-500">No saved report for this agent yet. Run the evaluation (or `npm run eval`).</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:grid-cols-5">
            <Stat label="Scenarios passed" value={`${Math.round(report.summary.passRate * 100)}%`} />
            <Stat label="Dimension score" value={`${Math.round(report.summary.avgScore * 100)}%`} />
            <Stat label="Runs" value={report.summary.runs} />
            <Stat label="Avg LLM / tool calls" value={`${report.summary.avgLlmCalls} / ${report.summary.avgToolCalls}`} />
            <Stat label="Tokens" value={report.summary.totalTokens.toLocaleString()} />
          </div>
          <div className="text-xs text-stone-500">
            {report.agent} · {new Date(report.startedAt).toLocaleString()}
          </div>
          <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
                <tr>
                  <th className="px-3 py-2">Scenario</th>
                  <th className="px-3 py-2">Decision</th>
                  <th className="px-3 py-2 text-right">New units</th>
                  {DIMS.map(([k, l]) => (
                    <th key={k} className="px-2 py-2 text-center">{l}</th>
                  ))}
                  <th className="px-3 py-2 text-center">Pass</th>
                </tr>
              </thead>
              <tbody>
                {report.grades.map((g, i) => (
                  <tr key={i} className="border-t border-stone-100 align-top">
                    <td className="px-3 py-2 font-mono text-xs">{g.scenarioId}</td>
                    <td className="px-3 py-2 text-xs">{g.finalDecision}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{g.newUnits}</td>
                    {DIMS.map(([k]) => {
                      const d = g.dimensions.find((x) => x.key === k)!;
                      return (
                        <td key={k} className="px-2 py-2 text-center" title={d.details.join("\n")}>
                          {d.status === "PASS" ? <span className="text-emerald-700">✓</span> : d.status === "FAIL" ? <span className="font-bold text-rose-700">✗</span> : <span className="text-stone-300">—</span>}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-center">{g.passed ? "✅" : "❌"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Card title="Why runs failed">
            <ul className="space-y-1 text-sm">
              {report.grades.flatMap((g) =>
                g.dimensions
                  .filter((d) => d.status === "FAIL")
                  .map((d) => (
                    <li key={`${g.runId}-${d.key}`}>
                      <span className="font-mono text-xs text-stone-500">{g.scenarioId}</span> · <span className="font-medium">{d.label}</span>{" "}
                      <span className="text-stone-600">— {d.details.join("; ")}</span>
                    </li>
                  )),
              )}
              {report.grades.every((g) => g.passed) && <li className="text-emerald-700">No failures.</li>}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
