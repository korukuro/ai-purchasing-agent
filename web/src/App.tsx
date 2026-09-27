import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { api } from "./api";
import ScenariosPage from "./pages/Scenarios";
import RunPage from "./pages/RunPage";
import RunsPage from "./pages/Runs";
import EvalsPage from "./pages/Evals";

export interface Health {
  llmConfigured: boolean;
  model: string;
  rpm: number;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    api.get<Health>("/api/health").then(setHealth).catch(() => setHealth(null));
  }, []);

  const link = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-3 py-1.5 text-sm ${isActive ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-200"}`;

  return (
    <div className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3">
          <div>
            <div className="text-base font-bold text-stone-900">AI Purchasing Agent</div>
            <div className="text-xs text-stone-500">investigate → decide → act → verify</div>
          </div>
          <nav className="flex gap-1">
            <NavLink to="/" end className={link}>Scenarios</NavLink>
            <NavLink to="/runs" className={link}>Runs</NavLink>
            <NavLink to="/evals" className={link}>Evaluation</NavLink>
          </nav>
          <div className="ml-auto text-xs">
            {health === null ? (
              <span className="text-rose-700">API offline</span>
            ) : health.llmConfigured ? (
              <span className="text-emerald-700">● LLM: {health.model} ({health.rpm} rpm)</span>
            ) : (
              <span className="text-amber-800">● GEMINI_API_KEY not set — baseline agent only</span>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Routes>
          <Route path="/" element={<ScenariosPage health={health} />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/evals" element={<EvalsPage health={health} />} />
        </Routes>
      </main>
    </div>
  );
}
