import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Badge } from "../components/ui";

interface RunRow {
  id: string;
  scenarioId: string;
  agent: string;
  status: string;
  createdAt: number;
  decision: string | null;
  passed: boolean | null;
}

export default function RunsPage() {
  const [rows, setRows] = useState<RunRow[]>([]);
  useEffect(() => {
    const load = () => api.get<RunRow[]>("/api/runs").then(setRows).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold text-stone-900">Runs</h1>
      {rows.length === 0 ? (
        <p className="text-sm text-stone-500">No runs yet. Start one from the Scenarios page.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Scenario</th>
                <th className="px-3 py-2">Agent</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Decision</th>
                <th className="px-3 py-2">Eval</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-stone-100 hover:bg-stone-50">
                  <td className="px-3 py-2 tabular-nums text-stone-500">{new Date(r.createdAt).toLocaleTimeString()}</td>
                  <td className="px-3 py-2">
                    <Link className="text-blue-700 hover:underline" to={`/runs/${r.id}`}>{r.scenarioId}</Link>
                  </td>
                  <td className="px-3 py-2 text-stone-600">{r.agent}</td>
                  <td className="px-3 py-2"><Badge tone={r.status}>{r.status.replaceAll("_", " ")}</Badge></td>
                  <td className="px-3 py-2">{r.decision ? <Badge tone={r.decision}>{r.decision}</Badge> : "—"}</td>
                  <td className="px-3 py-2">{r.passed === null ? "—" : r.passed ? "✅" : "❌"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
