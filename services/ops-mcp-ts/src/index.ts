import express from "express";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import pg from "pg";
import { z } from "zod";

const databaseUrl = process.env.DATABASE_URL;
const serviceToken = process.env.PROOFLINE_INTERNAL_TOKEN;
if (!databaseUrl || !serviceToken) throw new Error("DATABASE_URL and PROOFLINE_INTERNAL_TOKEN are required");
const prooflineServiceToken: string = serviceToken;

const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 3000 });
const prooflineUrl = process.env.PROOFLINE_URL ?? "http://localhost:8082";
const impactEngineUrl = (process.env.IMPACT_ENGINE_URL ?? "http://localhost:8002").replace(/\/+$/, "");
const allowInsecureLocalDemo = process.env.ALLOW_INSECURE_LOCAL_DEMO === "true";
const impactEngineInternalToken = process.env.IMPACT_ENGINE_INTERNAL_TOKEN;
const allowDemoMemoryActions = process.env.ALLOW_DEMO_MEMORY_ACTIONS === "true";
const mcpBearerToken = process.env.MCP_BEARER_TOKEN;
if (!impactEngineInternalToken && !allowInsecureLocalDemo) {
  throw new Error("IMPACT_ENGINE_INTERNAL_TOKEN is required unless ALLOW_INSECURE_LOCAL_DEMO=true");
}
if (!mcpBearerToken && !allowInsecureLocalDemo) {
  throw new Error("MCP_BEARER_TOKEN is required unless ALLOW_INSECURE_LOCAL_DEMO=true");
}
const allowedHosts = (process.env.MCP_ALLOWED_HOSTS ?? "localhost,127.0.0.1").split(",").map((host) => host.trim());
const runbookPath = process.env.TRACEHOLD_RUNBOOK_PATH ?? resolve(process.cwd(), "../../runbooks/tracehold-recall.yaml");
const onCallRunbookPath = process.env.ONCALL_RUNBOOK_PATH ?? resolve(process.cwd(), "../../runbooks/oncall-warehouse-incident.yaml");
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

async function warehouseSnapshot(): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(`${impactEngineUrl}/v1/warehouse/snapshot`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3500),
    });
    if (!response.ok) throw new Error(`warehouse snapshot returned ${response.status}`);
    const snapshot = await response.json();
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new Error("warehouse snapshot returned an invalid payload");
    }
    return snapshot as Record<string, unknown>;
  } catch (error) {
    const [lotSummary, orderSummary] = await Promise.all([
      pool.query(
        `SELECT status, COUNT(*)::int AS lots, COALESCE(SUM(quantity), 0)::int AS units
         FROM inventory.lots GROUP BY status ORDER BY status`,
      ),
      pool.query(
        `SELECT status, COUNT(*)::int AS orders, COALESCE(SUM(quantity), 0)::int AS units
         FROM inventory.orders GROUP BY status ORDER BY status`,
      ),
    ]);
    return {
      warehouse: {
        id: "relaygrid-local",
        name: "RelayGrid local warehouse",
        operatingMode: "degraded_read_only",
      },
      zones: [],
      robots: [],
      missions: [],
      anomalies: [
        {
          id: "SNAPSHOT-SOURCE-OFFLINE",
          severity: "high",
          type: "data_source_unavailable",
          message: error instanceof Error ? error.message : "warehouse snapshot is unavailable",
        },
      ],
      kpis: {
        activeRobots: 0,
        activeMissions: 0,
      },
      inventory: {
        lotsByStatus: lotSummary.rows,
        ordersByStatus: orderSummary.rows,
      },
      activity: [],
      meta: {
        source: "ops_mcp_inventory_fallback",
        degraded: true,
        generatedAt: new Date().toISOString(),
      },
    };
  }
}

async function impactRequest(path: string, options: { method?: string; body?: unknown } = {}): Promise<Record<string, any>> {
  const response = await fetch(`${impactEngineUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(impactEngineInternalToken ? { "X-RelayGrid-Internal-Token": impactEngineInternalToken } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(8000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data?.detail === "string" ? data.detail : `HTTP ${response.status}`;
    throw new Error(`impact engine rejected request (${detail})`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("impact engine returned an invalid payload");
  return data as Record<string, any>;
}

function registerTools(server: McpServer) {
  server.tool(
    "get_tracehold_runbook",
    "Return the human-authored TraceHold recall runbook. Follow steps in order; do not skip the approval gate.",
    {},
    readOnlyAnnotations,
    async () => textResult(await readFile(runbookPath, "utf8")),
  );

  server.tool(
    "get_oncall_runbook",
    "Return the human-authored warehouse incident runbook. Investigation is read-only; execute_incident_remediation always requires explicit human approval.",
    {},
    readOnlyAnnotations,
    async () => textResult(await readFile(onCallRunbookPath, "utf8")),
  );

  server.tool(
    "oncall_status",
    "Read the current on-call duty, incident counts, acknowledgement SLO, approval backlog and recent warehouse incidents.",
    {},
    readOnlyAnnotations,
    async () => textResult(await impactRequest("/v1/oncall/summary")),
  );

  server.tool(
    "incident_context",
    "Read one warehouse incident with correlated robot, mission, order, impact, evidence, runbook progress, timeline and prepared remediation intents.",
    { incidentId: z.string().min(1).max(120) },
    readOnlyAnnotations,
    async ({ incidentId }) => textResult(await impactRequest(`/v1/oncall/incidents/${encodeURIComponent(incidentId)}`)),
  );

  server.tool(
    "incident_memory",
    "Recall verified prior incidents matching the selected incident fingerprint. Results include the proven remediation and evidence summary; this never changes incident state.",
    { incidentId: z.string().min(1).max(120), limit: z.number().int().min(1).max(20).default(5) },
    readOnlyAnnotations,
    async ({ incidentId, limit }) => {
      const incident = await impactRequest(`/v1/oncall/incidents/${encodeURIComponent(incidentId)}`);
      const fingerprint = typeof incident.fingerprint === "string" ? incident.fingerprint : "";
      const query = new URLSearchParams({ fingerprint, limit: String(limit) });
      return textResult({
        incidentId,
        fingerprint,
        ...(await impactRequest(`/v1/oncall/memory?${query.toString()}`)),
      });
    },
  );

  server.tool(
    "prepare_incident_remediation",
    "Prepare one idempotent, approval-gated remediation for a warehouse incident. This records intent only and does not control a robot.",
    {
      incidentId: z.string().min(1).max(120),
      action: z.enum(["pause_robot", "send_to_charging", "clear_robot_anomaly", "reroute_robot"]),
      targetRobotId: z.string().min(1).max(120).optional(),
      targetZoneId: z.string().min(1).max(120).optional(),
      rationale: z.string().min(5).max(1000),
      scope: z.string().min(1).max(1000).optional(),
      rollback: z.string().min(1).max(1000).optional(),
      risk: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ incidentId, action, targetRobotId, targetZoneId, rationale, scope, rollback, risk }) => {
      const incident = await impactRequest(`/v1/oncall/incidents/${encodeURIComponent(incidentId)}`);
      const warehouse = await impactRequest("/v1/warehouse/snapshot");
      const warehouseMeta = warehouse.meta && typeof warehouse.meta === "object"
        ? warehouse.meta as Record<string, unknown>
        : {};
      const demoFallbackAllowed = allowDemoMemoryActions
        && warehouseMeta.source === "demo-memory"
        && warehouseMeta.databaseConfigured !== true
        && warehouseMeta.mutationStoreAvailable !== false;
      const incidentRobotId = typeof incident.robotId === "string" ? incident.robotId : undefined;
      if (targetRobotId && targetRobotId !== incidentRobotId) {
        throw new Error("targetRobotId must exactly match the incident robot");
      }
      const robotId = incidentRobotId;
      if (!robotId) throw new Error("incident has no robot target; targetRobotId is required");
      if (action === "reroute_robot" && !targetZoneId) throw new Error("reroute_robot requires targetZoneId");
      const targetRef = `${incidentId}:${robotId}`;
      const idempotencyKey = `oncall:${createHash("sha256")
        .update(`${incidentId}\0${action}\0${robotId}\0${targetZoneId ?? ""}`)
        .digest("hex")}`;

      let actionIntentId: string | undefined;
      let integrityMode: "proofline" | "demo-memory" = "proofline";
      let integrityWarning: string | undefined;
      try {
        const response = await fetch(`${prooflineUrl}/v1/actions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Proofline-Token": prooflineServiceToken,
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            actionType: "incident_remediation",
            targetRef,
            request: { incidentId, robotId, action, targetZoneId: targetZoneId ?? null, rationale, scope, rollback, risk },
          }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!response.ok) throw new Error(`Proofline returned ${response.status}`);
        const rawId = data.action_id ?? data.actionId;
        if (typeof rawId !== "string") throw new Error("Proofline did not return an action id");
        actionIntentId = rawId;
      } catch (error) {
        if (!demoFallbackAllowed) throw error;
        integrityMode = "demo-memory";
        integrityWarning = `Proofline unavailable; local demo intent is volatile (${error instanceof Error ? error.message : "unknown error"})`;
      }

      const prepared = await impactRequest(
        `/v1/oncall/incidents/${encodeURIComponent(incidentId)}/remediations/prepare`,
        {
          method: "POST",
          body: { action, targetRobotId: robotId, targetZoneId, rationale, scope, rollback, risk, actionIntentId, integrityMode },
        },
      );
      return textResult({ ...prepared, integrityMode, ...(integrityWarning ? { integrityWarning } : {}) });
    },
  );

  server.tool(
    "execute_incident_remediation",
    "STATE-CHANGING: execute exactly one prepared warehouse remediation. TrueForge must obtain explicit human approval for this exact tool call. The verifier returns APPLIED, NOT_APPLIED or UNKNOWN and never blindly retries.",
    {
      incidentId: z.string().min(1).max(120),
      actionIntentId: z.string().min(1).max(160),
      approvedBy: z.string().min(2).max(160),
      approvalNote: z.string().max(1000).optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ incidentId, actionIntentId, approvedBy, approvalNote }) => {
      const incident = await impactRequest(`/v1/oncall/incidents/${encodeURIComponent(incidentId)}`);
      const intents = Array.isArray(incident.remediationIntents) ? incident.remediationIntents : [];
      const intent = intents.find((item: any) => item?.id === actionIntentId) as Record<string, any> | undefined;
      if (!intent) throw new Error("prepared remediation intent was not found on this incident");
      if (intent.incidentId !== incidentId) throw new Error("remediation intent does not belong to this incident");
      const targetRef = `${incidentId}:${intent.targetRobotId}`;
      const usesProofline = intent.integrityMode === "proofline";
      if (["APPLIED", "NOT_APPLIED", "UNKNOWN", "EXECUTING"].includes(String(intent.state))) {
        const reconciled = await impactRequest(
          `/v1/oncall/incidents/${encodeURIComponent(incidentId)}/remediations/${encodeURIComponent(actionIntentId)}/reconcile`,
          { method: "POST" },
        );
        if (usesProofline) {
          const verificationState = reconciled?.verification?.state;
          const prooflineState = verificationState === "APPLIED"
            ? "APPLIED"
            : verificationState === "NOT_APPLIED" ? "NOT_APPLIED" : "UNKNOWN";
          await recordOutcome(
            actionIntentId,
            prooflineState,
            targetRef,
            { incidentId, action: intent.action, reconciliation: reconciled.verification, executed: false },
          );
        }
        return textResult({ ...reconciled, idempotent: true });
      }
      if (intent.state !== "PENDING_APPROVAL") throw new Error(`remediation is not executable from state ${intent.state}`);
      if (usesProofline) {
        const authorize = await fetch(`${prooflineUrl}/v1/actions/${encodeURIComponent(actionIntentId)}/authorize`, {
          method: "POST",
          headers: { "content-type": "application/json", "X-Proofline-Token": prooflineServiceToken },
          body: JSON.stringify({ approvedBy, targetRef }),
          signal: AbortSignal.timeout(8000),
        });
        const authorized = await authorize.json().catch(() => ({})) as Record<string, unknown>;
        if (!authorize.ok) throw new Error(`Proofline did not authorize action (${authorize.status})`);
        if (authorized.action_type !== "incident_remediation" || authorized.target_ref !== targetRef || authorized.state !== "EXECUTING") {
          throw new Error("Proofline intent does not match this incident remediation or was not claimed for execution");
        }
      } else if (!allowDemoMemoryActions) {
        throw new Error("volatile demo-memory actions are disabled");
      }

      try {
        const applied = await impactRequest(
          `/v1/oncall/incidents/${encodeURIComponent(incidentId)}/remediations/${encodeURIComponent(actionIntentId)}/execute`,
          { method: "POST", body: { approvedBy, approvalNote } },
        );
        const verificationState = applied?.verification?.state;
        if (usesProofline) {
          const prooflineState = verificationState === "APPLIED"
            ? "APPLIED"
            : verificationState === "NOT_APPLIED" ? "NOT_APPLIED" : "UNKNOWN";
          await recordOutcome(
            actionIntentId,
            prooflineState,
            targetRef,
            { incidentId, action: intent.action, verification: applied.verification },
          );
        }
        return textResult(applied);
      } catch (error) {
        if (usesProofline) {
          await recordOutcome(actionIntentId, "UNKNOWN", targetRef, {
            incidentId,
            action: intent.action,
            message: error instanceof Error ? error.message : "remediation outcome is unknown",
          }).catch(() => undefined);
        }
        throw error;
      }
    },
  );

  server.tool(
    "warehouse_snapshot",
    "Read the current warehouse overview, zones, KPIs, inventory, activity, missions, anomalies and robots. Uses the digital-twin service and reports a clearly marked inventory-only fallback when it is unavailable.",
    {},
    readOnlyAnnotations,
    async () => textResult(await warehouseSnapshot()),
  );

  server.tool(
    "fleet_status",
    "Read current robot, mission and fleet-anomaly state from the warehouse digital twin. This tool never dispatches or controls a robot.",
    {},
    readOnlyAnnotations,
    async () => {
      const snapshot = await warehouseSnapshot();
      return textResult({
        warehouse: snapshot.warehouse,
        robots: snapshot.robots ?? [],
        missions: snapshot.missions ?? [],
        anomalies: snapshot.anomalies ?? [],
        kpis: snapshot.kpis ?? {},
        meta: snapshot.meta ?? {},
      });
    },
  );

  server.tool(
    "digital_twin_state",
    "Read the render-ready state of the warehouse digital twin, including zones, robot positions, missions, inventory, activity and anomalies. This tool never advances or mutates the simulation.",
    {},
    readOnlyAnnotations,
    async () => textResult(await warehouseSnapshot()),
  );

  server.tool(
    "inventory_get_lots",
    "Read lot status and on-hand quantities for a recall investigation. This tool never changes inventory.",
    { lotIds: z.array(z.string().min(1).max(120)).min(1).max(100) },
    readOnlyAnnotations,
    async ({ lotIds }) => {
      const result = await pool.query(
        "SELECT lot_id, sku, product_name, quantity, status, updated_at FROM inventory.lots WHERE lot_id = ANY($1::text[]) ORDER BY lot_id",
        [lotIds],
      );
      return { content: [{ type: "text", text: JSON.stringify(result.rows) }] };
    },
  );

  server.tool(
    "orders_for_lots",
    "Read order references, quantities, and statuses for affected lots. This tool never changes orders.",
    { lotIds: z.array(z.string().min(1).max(120)).min(1).max(100) },
    readOnlyAnnotations,
    async ({ lotIds }) => {
      const result = await pool.query(
        "SELECT order_id, lot_id, quantity, status, created_at FROM inventory.orders WHERE lot_id = ANY($1::text[]) ORDER BY created_at DESC LIMIT 500",
        [lotIds],
      );
      return { content: [{ type: "text", text: JSON.stringify(result.rows) }] };
    },
  );

  server.tool(
    "prepare_quarantine",
    "Create a durable Proofline intent for quarantining one recalled lot. This only prepares the action; it does not change inventory.",
    {
      recallId: z.string().min(1).max(120),
      lotId: z.string().min(1).max(120),
      reason: z.string().min(5).max(2000),
      impactSummary: z.string().min(1).max(2000),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ recallId, lotId, reason, impactSummary }) => {
      const response = await fetch(`${prooflineUrl}/v1/actions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Proofline-Token": prooflineServiceToken,
          "Idempotency-Key": `tracehold:${createHash("sha256").update(`${recallId}\0${lotId}`).digest("hex")}`,
        },
        body: JSON.stringify({
          actionType: "quarantine_lot",
          targetRef: lotId,
          request: { recallId, lotId, reason, impactSummary },
        }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`Proofline rejected intent (${response.status})`);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
  );

  server.tool(
    "quarantine_lot",
    "STATE-CHANGING: quarantine exactly one lot. TrueForge must request explicit human tool approval before dispatching this call. Requires the Proofline action ID returned by prepare_quarantine.",
    { actionId: z.string().uuid(), lotId: z.string().min(1).max(120) },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async ({ actionId, lotId }) => {
      const authorize = await fetch(`${prooflineUrl}/v1/actions/${actionId}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Proofline-Token": prooflineServiceToken },
        body: JSON.stringify({ approvedBy: `trueforge-human-tool-approval:${actionId}`, targetRef: lotId }),
        signal: AbortSignal.timeout(8000),
      });
      const action = await authorize.json();
      if (!authorize.ok) throw new Error(`Proofline did not authorize action (${authorize.status})`);
      if (action.action_type !== "quarantine_lot" || action.target_ref !== lotId || action.state !== "EXECUTING") {
        throw new Error("Proofline intent does not match this lot or was not claimed for execution");
      }

      const client = await pool.connect();
      let alreadyQuarantined = false;
      let commitStarted = false;
      try {
        await client.query("BEGIN");
        const current = await client.query("SELECT lot_id, status FROM inventory.lots WHERE lot_id = $1 FOR UPDATE", [lotId]);
        if (current.rowCount === 0) throw new Error("lot not found");
        if (current.rows[0].status === "quarantined") {
          alreadyQuarantined = true;
        } else if (current.rows[0].status !== "available") {
          throw new Error(`lot cannot be quarantined from state ${current.rows[0].status}`);
        } else {
          await client.query("UPDATE inventory.lots SET status = 'quarantined', updated_at = now() WHERE lot_id = $1", [lotId]);
        }
        commitStarted = true;
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        await recordOutcome(actionId, commitStarted ? "UNKNOWN" : "NOT_APPLIED", lotId, { message: error instanceof Error ? error.message : "inventory update failed", commitStarted }).catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      const finalLot = await pool.query("SELECT lot_id, sku, quantity, status, updated_at FROM inventory.lots WHERE lot_id = $1", [lotId]);
      const verified = finalLot.rows[0];
      if (!verified || verified.status !== "quarantined") {
        await recordOutcome(actionId, "UNKNOWN", lotId, { verification: "quarantine not visible after write" });
        throw new Error("quarantine outcome is unknown; stop and reconcile with an operator");
      }
      const saved = await recordOutcome(actionId, "APPLIED", lotId, { alreadyQuarantined, verifiedLot: verified });
      return { content: [{ type: "text", text: JSON.stringify({ action: saved, verifiedLot: verified }) }] };
    },
  );
}

async function recordOutcome(actionId: string, state: "APPLIED" | "NOT_APPLIED" | "UNKNOWN", lotId: string, details: unknown) {
  const response = await fetch(`${prooflineUrl}/v1/actions/${actionId}/outcome`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Proofline-Token": prooflineServiceToken },
    body: JSON.stringify({ state, downstreamRef: lotId, detailsJson: JSON.stringify(details) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Proofline could not record outcome (${response.status})`);
  return response.json();
}

const app = express();
app.use(hostHeaderValidation(allowedHosts));
app.use(express.json({ limit: "1mb" }));
app.get("/health", (_request, response) => response.json({ service: "relaygrid-operations-mcp", status: "ok" }));
app.get("/mcp", (request, response) => {
  if (mcpBearerToken && request.header("authorization") !== `Bearer ${mcpBearerToken}`) {
    response.status(401).json({ error: "unauthorized" });
    return;
  }
  response.set("Allow", "POST").status(405).json({ error: "method_not_allowed" });
});
app.post("/mcp", async (request, response) => {
  if (mcpBearerToken && request.header("authorization") !== `Bearer ${mcpBearerToken}`) {
    response.status(401).json({ error: "unauthorized" });
    return;
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = new McpServer({ name: "relaygrid-operations", version: "0.3.0" });
  registerTools(server);
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "MCP request failed"}\n`);
    if (!response.headersSent) response.status(500).json({ error: "mcp_request_failed" });
  }
});

const port = Number(process.env.PORT ?? 8083);
const mcpHost = process.env.MCP_HOST ?? "127.0.0.1";
const httpServer = app.listen(port, mcpHost, () => process.stdout.write(`Operations MCP listening at http://${mcpHost}:${port}/mcp\n`));
const close = async () => {
  httpServer.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
