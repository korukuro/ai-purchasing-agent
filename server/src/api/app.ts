import express, { type Request, type Response } from "express";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { runAgent, type Approver } from "../agent/orchestrator.js";
import { RunStore, type Run } from "../agent/runs.js";
import { gradeRun, type Grade } from "../eval/grader.js";
import { makeClient, RESULTS_DIR, runEval, saveReport, type AgentKind } from "../eval/runner.js";
import { getScenario, SCENARIOS } from "../scenarios/index.js";
import { World } from "../domain/world.js";
import { projectInventory } from "../domain/planning.js";

export function createApp() {
  const app = express();
  app.use(express.json());
  const store = new RunStore();
  const grades = new Map<string, Grade>();
  let evalJob: { agent: AgentKind; running: boolean; log: string[]; startedAt: number; error?: string } | null = null;

  const scenarioSummary = (id: string) => {
    const s = getScenario(id);
    const w = new World(s.world);
    const { sku, nodeId } = s.trigger.context;
    const p = w.product(sku);
    return {
      id: s.id,
      assignmentScenario: s.assignmentScenario,
      title: s.title,
      description: s.description,
      trigger: s.trigger,
      product: p,
      onHand: w.inventory(sku, nodeId).onHand,
      openPOs: w.openPOs(sku, nodeId).length,
      forecastPerDay: w.demand(sku, nodeId).forecast[0],
    };
  };

  const runView = (run: Run) => ({ ...run, grade: grades.get(run.id) ?? null });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, llmConfigured: Boolean(config.geminiApiKey), model: config.geminiModel, rpm: config.llmRpm });
  });

  app.get("/api/scenarios", (_req, res) => {
    res.json(SCENARIOS.map((s) => scenarioSummary(s.id)));
  });

  app.get("/api/scenarios/:id", (req, res) => {
    try {
      const s = getScenario(req.params.id);
      const w = new World(s.world);
      const { sku, nodeId } = s.trigger.context;
      res.json({ ...scenarioSummary(s.id), world: s.world, expectations: s.expectations, projection: projectInventory(w, sku, nodeId) });
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  app.post("/api/runs", (req: Request, res: Response) => {
    const { scenarioId, agent = "gemini", approvalMode = "manual" } = req.body ?? {};
    let scenario;
    try {
      scenario = getScenario(scenarioId);
    } catch (e) {
      return void res.status(404).json({ error: (e as Error).message });
    }
    if (agent === "gemini" && !config.geminiApiKey) {
      return void res.status(400).json({ error: "GEMINI_API_KEY is not configured on the server (.env). You can still run the baseline agent." });
    }
    const client = makeClient(agent as AgentKind, scenario);
    const run = store.create(scenario.id, client.name);
    const approver: Approver =
      approvalMode === "auto" ? async () => ({ approved: true, by: "auto-approve (demo)" }) : (r) => store.waitForApproval(r.id);
    runAgent(scenario, client, store, approver, {}, run)
      .then((r) => {
        grades.set(r.id, gradeRun(scenario!, r));
        store.update(r);
      })
      .catch((e) => console.error(e));
    res.status(201).json({ runId: run.id });
  });

  app.get("/api/runs", (_req, res) => {
    res.json(
      store.list().map((r) => ({
        id: r.id,
        scenarioId: r.scenarioId,
        agent: r.agent,
        status: r.status,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
        decision: r.plans.filter((p) => p.execution).at(-1)?.plan.decision ?? null,
        passed: grades.get(r.id)?.passed ?? null,
      })),
    );
  });

  app.get("/api/runs/:id", (req, res) => {
    const run = store.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run not found" });
    res.json(runView(run));
  });

  // Server-Sent Events: replay past events, then stream live ones.
  app.get("/api/runs/:id/stream", (req, res) => {
    const run = store.get(req.params.id);
    if (!run) return void res.status(404).end();
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const ev of run.events) send("event", ev);
    send("run", runView(run));
    const unsub = store.subscribe(
      run.id,
      (ev) => send("event", ev),
      (r) => send("run", runView(r)),
    );
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      unsub();
    });
  });

  app.post("/api/runs/:id/approval", (req, res) => {
    const { approved, comment } = req.body ?? {};
    const ok = store.resolveApproval(req.params.id, { approved: Boolean(approved), by: "buyer (UI)", comment });
    if (!ok) return void res.status(409).json({ error: "run is not waiting for approval" });
    res.json({ ok: true });
  });

  // ---- evaluation -------------------------------------------------------
  app.get("/api/evals/:agent", (req, res) => {
    const file = `${RESULTS_DIR}latest-${req.params.agent}.json`;
    if (!existsSync(file)) return void res.json(null);
    res.json(JSON.parse(readFileSync(file, "utf8")));
  });

  app.get("/api/eval-job", (_req, res) => res.json(evalJob));

  app.post("/api/evals", (req, res) => {
    const agent = (req.body?.agent ?? "gemini") as AgentKind;
    if (evalJob?.running) return void res.status(409).json({ error: "an evaluation is already running" });
    if (agent === "gemini" && !config.geminiApiKey) return void res.status(400).json({ error: "GEMINI_API_KEY is not configured" });
    const job: NonNullable<typeof evalJob> = { agent, running: true, log: [], startedAt: Date.now() };
    evalJob = job;
    runEval({ agent, scenarioIds: req.body?.scenarioIds, store, onProgress: (m) => job.log.push(m) })
      .then((r) => saveReport(r, agent))
      .catch((e) => (job.error = (e as Error).message))
      .finally(() => (job.running = false));
    res.status(202).json({ ok: true });
  });

  // ---- serve the built frontend (npm run build && npm start) -------------
  const dist = fileURLToPath(new URL("../../../web/dist/", import.meta.url));
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(`${dist}index.html`));
  }

  return app;
}
