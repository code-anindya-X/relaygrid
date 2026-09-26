import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";

const RecallInput = z.object({
  recallId: z.string().min(1).max(120),
  supplier: z.string().min(1).max(200),
  lotIds: z.array(z.string().min(1).max(120)).min(1).max(100).refine((ids) => new Set(ids).size === ids.length),
  reason: z.string().min(5).max(2000),
}).strict();

const TraceHoldState = Annotation.Root({
  request: Annotation<z.infer<typeof RecallInput>>(),
  runbook: Annotation<unknown>({ reducer: (_old, next) => next, default: () => null }),
  impact: Annotation<unknown | null>({ reducer: (_old, next) => next, default: () => null }),
  actionPreviews: Annotation<Array<Record<string, unknown>>>({ reducer: (_old, next) => next, default: () => [] }),
  phase: Annotation<string>({ reducer: (_old, next) => next, default: () => "received" }),
});

const graph = new StateGraph(TraceHoldState)
  .addNode("load_runbook", async () => {
    const path = process.env.TRACEHOLD_RUNBOOK_PATH ?? resolve(process.cwd(), "../../runbooks/tracehold-recall.yaml");
    const source = await readFile(path, "utf8");
    const runbook = parseYaml(source) as { name?: string; version?: number; steps?: unknown[] };
    if (!runbook.name || !Array.isArray(runbook.steps)) throw new Error("TraceHold runbook is invalid");
    return { runbook, phase: "runbook_loaded" };
  })
  .addNode("analyze_impact", async (state) => {
    const base = process.env.IMPACT_ENGINE_URL ?? "http://localhost:8002";
    const response = await fetch(`${base}/v1/recalls/impact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recallId: state.request.recallId, lotIds: state.request.lotIds }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`impact engine returned ${response.status}`);
    return { impact: await response.json(), phase: "impact_ready" };
  })
  .addNode("prepare_action_previews", async (state) => {
    const impact = state.impact as { lots?: Array<{ lotId: string; onHandUnits: number; status: string }> };
    const prooflineUrl = process.env.PROOFLINE_URL ?? "http://localhost:8082";
    const serviceToken = process.env.PROOFLINE_INTERNAL_TOKEN;
    if (!serviceToken) throw new Error("Proofline service token is not configured");
    const eligible = (impact.lots ?? []).filter((lot) => lot.status === "available" && lot.onHandUnits > 0);
    const actionPreviews = await Promise.all(eligible.map(async (lot) => {
      const idempotencyKey = `tracehold:${createHash("sha256").update(`${state.request.recallId}\0${lot.lotId}`).digest("hex")}`;
      const response = await fetch(`${prooflineUrl}/v1/actions`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Proofline-Token": serviceToken, "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          actionType: "quarantine_lot",
          targetRef: lot.lotId,
          request: { recallId: state.request.recallId, supplier: state.request.supplier, lotId: lot.lotId, reason: state.request.reason },
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`Proofline action preview failed (${response.status})`);
      return response.json() as Promise<Record<string, unknown>>;
    }));
    return { actionPreviews, phase: "awaiting_operator_review" };
  })
  .addEdge(START, "load_runbook")
  .addEdge("load_runbook", "analyze_impact")
  .addEdge("analyze_impact", "prepare_action_previews")
  .addEdge("prepare_action_previews", END)
  .compile();

const app = Fastify({ logger: true, bodyLimit: 32 * 1024 });
await app.register(cors, { origin: process.env.CONSOLE_ORIGIN ?? "http://localhost:5173" });
const controlPlaneInternalToken = process.env.CONTROL_PLANE_INTERNAL_TOKEN?.trim();
const allowInsecureLocalDemo = process.env.ALLOW_INSECURE_LOCAL_DEMO === "true";
if (!controlPlaneInternalToken && !allowInsecureLocalDemo) {
  throw new Error("CONTROL_PLANE_INTERNAL_TOKEN is required unless ALLOW_INSECURE_LOCAL_DEMO=true");
}
app.get("/health", async () => ({ service: "relaygrid-control-plane", status: "ok" }));
app.post("/v1/tracehold/recalls", async (request, reply) => {
  const parsed = RecallInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
  try {
    const state = await graph.invoke({ request: parsed.data });
    return reply.code(202).send({
      recallId: parsed.data.recallId,
      phase: state.phase,
      runbook: state.runbook,
      impact: state.impact,
      actionPreviews: state.actionPreviews,
      nextStep: "Review each prepared action in TrueForge. No inventory changes until an operator approves quarantine_lot.",
    });
  } catch (error) {
    request.log.error(error);
    return reply.code(502).send({ error: "impact_analysis_unavailable" });
  }
});

// Keep the console on one control-plane origin while the deterministic Python
// service owns warehouse simulation and inventory calculations. The prefix is
// deliberately narrow: arbitrary upstream URLs cannot be supplied by callers.
app.all("/v1/warehouse/*", async (request, reply) => {
  const base = process.env.IMPACT_ENGINE_URL ?? "http://localhost:8002";
  try {
    const response = await fetch(`${base}${request.url}`, {
      method: request.method,
      headers: { "content-type": "application/json" },
      body: request.method === "GET" || request.method === "HEAD" ? undefined : JSON.stringify(request.body ?? {}),
      signal: AbortSignal.timeout(10_000),
    });
    const contentType = response.headers.get("content-type") ?? "application/json";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();
    return reply.code(response.status).type(contentType).send(payload);
  } catch (error) {
    request.log.error(error);
    return reply.code(502).send({ error: "warehouse_engine_unavailable" });
  }
});

// The public control plane exposes reads and human lifecycle updates only.
// Remediation prepare/execute/reconcile stay reachable solely from the
// authenticated Operations MCP and never receive an injected internal token.
const proxyOnCallLifecycle = async (request: FastifyRequest, reply: FastifyReply) => {
  if (request.method !== "GET" && request.headers["x-relaygrid-control-token"] !== controlPlaneInternalToken) {
    return reply.code(401).send({ error: "invalid_control_plane_credential" });
  }
  const base = process.env.IMPACT_ENGINE_URL ?? "http://localhost:8002";
  try {
    const response = await fetch(`${base}${request.url}`, {
      method: request.method,
      headers: { "content-type": "application/json" },
      body: request.method === "GET" || request.method === "HEAD" ? undefined : JSON.stringify(request.body ?? {}),
      signal: AbortSignal.timeout(10_000),
    });
    const contentType = response.headers.get("content-type") ?? "application/json";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();
    return reply.code(response.status).type(contentType).send(payload);
  } catch (error) {
    request.log.error(error);
    return reply.code(502).send({ error: "oncall_engine_unavailable" });
  }
};

app.get("/v1/oncall/summary", proxyOnCallLifecycle);
app.get("/v1/oncall/incidents", proxyOnCallLifecycle);
app.get("/v1/oncall/memory", proxyOnCallLifecycle);
app.get("/v1/oncall/incidents/:incidentId", proxyOnCallLifecycle);
app.post("/v1/oncall/detect", proxyOnCallLifecycle);
app.post("/v1/oncall/incidents/:incidentId/acknowledge", proxyOnCallLifecycle);
app.post("/v1/oncall/incidents/:incidentId/investigate", proxyOnCallLifecycle);
app.post("/v1/oncall/incidents/:incidentId/escalate", proxyOnCallLifecycle);
app.post("/v1/oncall/incidents/:incidentId/timeline", proxyOnCallLifecycle);
app.post("/v1/oncall/incidents/:incidentId/resolve", proxyOnCallLifecycle);

const port = Number(process.env.PORT ?? 8084);
await app.listen({ host: process.env.CONTROL_PLANE_HOST ?? "127.0.0.1", port });
