import { demoState, summarizeDemoIncidents, updateDemoIncident } from "@/lib/demo-store";
import { readOperatorSession, requestHasTrustedOrigin } from "@/lib/operator-session";
import type { OnCallActionName, OnCallIncident, OnCallSummary } from "@/lib/types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const dynamic = "force-dynamic";

type RouteParams = { path?: string[] };

const engineRoot = (process.env.ONCALL_SERVICE_URL ?? process.env.CONTROL_PLANE_URL ?? process.env.IMPACT_ENGINE_URL ?? "http://127.0.0.1:8084").replace(/\/$/, "");
const upstreamBase = engineRoot.endsWith("/v1/oncall") ? engineRoot : `${engineRoot}/v1/oncall`;
const opsMcpRoot = (process.env.OPS_MCP_URL ?? "http://127.0.0.1:8083").replace(/\/$/, "");
const opsMcpUrl = opsMcpRoot.endsWith("/mcp") ? opsMcpRoot : `${opsMcpRoot}/mcp`;
const controlPlaneInternalToken = process.env.CONTROL_PLANE_INTERNAL_TOKEN;

function proofLabel(value: unknown) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const proof = value as Record<string, unknown>;
  const receipt = typeof proof.receiptId === "string" ? `Receipt ${proof.receiptId}` : undefined;
  const intent = typeof proof.actionIntentId === "string" ? `intent ${proof.actionIntentId}` : undefined;
  const evidence = typeof proof.evidenceHash === "string" ? `evidence ${proof.evidenceHash.slice(0, 12)}…` : undefined;
  return [receipt, intent, evidence].filter(Boolean).join(" · ") || JSON.stringify(proof);
}

function normalizeIncident(raw: Record<string, any>): OnCallIncident {
  const stepStatus: Record<string, "pending" | "active" | "complete" | "blocked"> = {
    DONE: "complete", COMPLETE: "complete", ACTIVE: "active", AWAITING_APPROVAL: "active", BLOCKED: "blocked", PENDING: "pending",
  };
  const evidenceKind: Record<string, "signal" | "metric" | "log" | "agent" | "operator" | "action"> = {
    anomaly: "signal", fleet_snapshot: "metric", signal: "signal", metric: "metric", log: "log", agent: "agent", operator: "operator", action: "action",
  };
  const remediation = raw.remediation && typeof raw.remediation === "object" ? raw.remediation as Record<string, any> : undefined;
  const remediationState: Record<string, "PROPOSED" | "APPROVED" | "EXECUTING" | "EXECUTED" | "REJECTED" | "NOT_APPLIED" | "UNKNOWN"> = {
    PENDING_APPROVAL: "PROPOSED", READY: "APPROVED", APPROVED: "APPROVED", EXECUTING: "EXECUTING", APPLIED: "EXECUTED", EXECUTED: "EXECUTED", REJECTED: "REJECTED", NOT_APPLIED: "NOT_APPLIED", UNKNOWN: "UNKNOWN",
  };
  const verification = remediation?.verification && typeof remediation.verification === "object"
    ? remediation.verification as Record<string, any>
    : undefined;
  const normalizedRemediation = remediation ? {
    id: String(remediation.id ?? remediation.intentId ?? `REM-${raw.id}`),
    summary: String(remediation.summary ?? remediation.rationale ?? `${String(remediation.action || "bounded action").replaceAll("_", " ")}`),
    action: String(remediation.action ?? "bounded_action"),
    scope: String(remediation.scope ?? ([remediation.targetRobotId, remediation.targetZoneId].filter(Boolean).join(" · ") || "Incident-scoped action")),
    rollback: String(remediation.rollback ?? "Pause execution and restore the previous robot assignment"),
    risk: remediation.risk === "LOW" || remediation.risk === "HIGH" ? remediation.risk : "MEDIUM" as const,
    status: remediationState[String(remediation.status ?? remediation.state)] ?? "PROPOSED" as const,
    proposedBy: String(remediation.proposedBy ?? "RelayGrid on-call agent"),
    proposedAt: String(remediation.proposedAt ?? remediation.createdAt ?? raw.updatedAt),
    ...(remediation.approvedBy ? { approvedBy: String(remediation.approvedBy) } : {}),
    ...(remediation.approvedAt ? { approvedAt: String(remediation.approvedAt) } : {}),
    ...(verification ? { verification: {
      state: verification.state === "APPLIED" ? "APPLIED" as const : verification.state === "NOT_APPLIED" ? "NOT_APPLIED" as const : "UNKNOWN" as const,
      detail: String(verification.detail ?? "The physical outcome could not be attributed."),
      ...(proofLabel(verification.attributableProof) ? { attributableProof: proofLabel(verification.attributableProof)! } : {}),
      ...(verification.verifiedAt ? { verifiedAt: String(verification.verifiedAt) } : {}),
    } } : {}),
  } : undefined;
  return {
    id: String(raw.id),
    title: String(raw.title ?? "Warehouse incident"),
    summary: String(raw.summary ?? "Evidence is being correlated."),
    severity: ["SEV1", "SEV2", "SEV3", "SEV4"].includes(raw.severity) ? raw.severity : "SEV3",
    status: raw.status,
    service: String(raw.service ?? "warehouse-operations"),
    source: String(raw.source ?? "on-call-engine"),
    ...(raw.owner ? { owner: String(raw.owner) } : {}),
    ...(raw.commander ? { commander: String(raw.commander) } : {}),
    createdAt: String(raw.createdAt),
    updatedAt: String(raw.updatedAt),
    ...(raw.acknowledgedAt ? { acknowledgedAt: String(raw.acknowledgedAt) } : {}),
    ...(raw.resolvedAt ? { resolvedAt: String(raw.resolvedAt) } : {}),
    slaMinutes: Number(raw.slaMinutes ?? 15),
    labels: Array.isArray(raw.labels) ? raw.labels.map(String) : [],
    impact: {
      headline: String(raw.impact?.headline ?? "Impact is still being calculated."),
      ordersAtRisk: Number(raw.impact?.ordersAtRisk ?? 0),
      robotsAffected: Number(raw.impact?.robotsAffected ?? 0),
      zonesAffected: Array.isArray(raw.impact?.zonesAffected) ? raw.impact.zonesAffected.map(String) : [],
    },
    evidence: Array.isArray(raw.evidence) ? raw.evidence.map((item: Record<string, any>) => ({
      id: String(item.id), kind: evidenceKind[String(item.kind)] ?? "signal", title: String(item.title), detail: String(item.detail),
      source: String(item.source ?? "on-call-engine"), createdAt: String(item.createdAt),
      ...(typeof item.confidence === "number" ? { confidence: item.confidence } : {}),
    })) : [],
    runbook: {
      name: String(raw.runbook?.name ?? "Incident response"), version: String(raw.runbook?.version ?? "1"),
      steps: Array.isArray(raw.runbook?.steps) ? raw.runbook.steps.map((step: Record<string, any>) => ({
        id: String(step.id), title: String(step.title), description: String(step.description),
        status: stepStatus[String(step.status)] ?? (step.status || "pending"), requiresApproval: Boolean(step.requiresApproval),
        ...(Array.isArray(step.evidenceIds) ? { evidenceIds: step.evidenceIds.map(String) } : {}),
      })) : [],
    },
    ...(normalizedRemediation ? { remediation: normalizedRemediation } : {}),
    escalations: Array.isArray(raw.escalations) ? raw.escalations.map((item: Record<string, any>) => ({
      id: String(item.id), target: String(item.target), reason: String(item.reason), actor: String(item.actor), createdAt: String(item.createdAt),
    })) : [],
    ...(Array.isArray(raw.similarIncidents) ? { similarIncidents: raw.similarIncidents.map((item: Record<string, any>) => ({
      incidentId: String(item.incidentId), similarity: Number(item.similarity ?? 0), remediationAction: String(item.remediationAction ?? "unknown"), verified: Boolean(item.verified),
    })) } : {}),
    ...(raw.suggestedPlaybook && typeof raw.suggestedPlaybook === "object" ? { suggestedPlaybook: {
      id: String(raw.suggestedPlaybook.id), name: String(raw.suggestedPlaybook.name), confidence: Number(raw.suggestedPlaybook.confidence ?? 0),
      sourceEpisodes: Array.isArray(raw.suggestedPlaybook.sourceEpisodes) ? raw.suggestedPlaybook.sourceEpisodes.map(String) : [],
      steps: Array.isArray(raw.suggestedPlaybook.steps) ? raw.suggestedPlaybook.steps.map(String) : [],
    } } : {}),
    ...(Array.isArray(raw.timeline) ? { timeline: raw.timeline.map((item: Record<string, any>) => ({
      id: String(item.id), type: String(item.type), actor: String(item.actor), message: String(item.message), createdAt: String(item.createdAt),
    })) } : {}),
  };
}

function cloneIncidents() {
  return structuredClone(demoState().incidents);
}

function filteredDemoIncidents(url: URL) {
  const severity = url.searchParams.get("severity")?.toUpperCase();
  const status = url.searchParams.get("status")?.toUpperCase();
  const owner = url.searchParams.get("owner")?.trim().toLowerCase();
  const query = url.searchParams.get("q")?.trim().toLowerCase();
  const rank: Record<string, number> = { SEV1: 1, SEV2: 2, SEV3: 3, SEV4: 4 };
  return cloneIncidents().filter((incident) =>
    (!severity || incident.severity === severity) &&
    (!status || incident.status === status) &&
    (!owner || (owner === "unowned" ? !incident.owner : incident.owner?.toLowerCase().includes(owner))) &&
    (!query || [incident.id, incident.title, incident.summary, incident.service, incident.owner, ...incident.labels]
      .filter(Boolean).some((value) => String(value).toLowerCase().includes(query)))
  ).sort((a, b) => {
    if ((a.status === "RESOLVED") !== (b.status === "RESOLVED")) return a.status === "RESOLVED" ? 1 : -1;
    return (rank[a.severity] - rank[b.severity]) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

function summaryFromIncidents(incidents: OnCallIncident[]): OnCallSummary {
  const acknowledged = incidents.filter((incident) => incident.acknowledgedAt);
  const mean = acknowledged.length
    ? acknowledged.reduce((sum, incident) => sum + Math.max(0, Date.parse(incident.acknowledgedAt!) - Date.parse(incident.createdAt)), 0) / acknowledged.length / 60_000
    : 0;
  const active = incidents.filter((incident) => incident.status !== "RESOLVED");
  return {
    total: incidents.length,
    active: active.length,
    critical: active.filter((incident) => incident.severity === "SEV1").length,
    unowned: active.filter((incident) => !incident.owner).length,
    awaitingApproval: active.filter((incident) => incident.status === "AWAITING_APPROVAL").length,
    resolved: incidents.length - active.length,
    meanAcknowledgeMinutes: Number(mean.toFixed(1)),
  };
}

async function upstream(path: string, method = "GET", body?: Record<string, unknown>) {
  return fetch(`${upstreamBase}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(method !== "GET" && controlPlaneInternalToken
        ? { "X-RelayGrid-Control-Token": controlPlaneInternalToken }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(1_400),
  });
}

async function callOperationsTool(name: string, args: Record<string, unknown>) {
  const token = process.env.MCP_BEARER_TOKEN;
  const client = new Client({ name: "relaygrid-console", version: "0.3.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(opsMcpUrl), {
    requestInit: {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10_000),
    },
  });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name, arguments: args });
    const content = Array.isArray(response.content) ? response.content as Array<Record<string, unknown>> : [];
    if (response.isError) {
      const message = content.find((item) => item.type === "text")?.text;
      throw new Error(typeof message === "string" ? message : "Operations MCP tool failed");
    }
    const text = content.find((item) => item.type === "text")?.text;
    if (typeof text !== "string") throw new Error("Operations MCP returned no JSON result");
    const result = JSON.parse(text) as Record<string, any>;
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Operations MCP returned invalid JSON");
    return result;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function unknownMutation(message: string) {
  return Response.json({
    error: message,
    outcome: "UNKNOWN",
    reconciliationRequired: true,
  }, { status: 502 });
}

async function proxyList(url: URL) {
  const search = new URLSearchParams();
  for (const key of ["status", "severity", "owner", "q"]) {
    const value = url.searchParams.get(key);
    if (value) search.set(key, value);
  }
  const suffix = search.size ? `?${search.toString()}` : "";
  const [listResponse, summaryResponse] = await Promise.all([
    upstream(`/incidents${suffix}`),
    upstream("/summary"),
  ]);
  if (!listResponse.ok) throw new Error(`On-call engine returned ${listResponse.status}`);
  const listPayload = await listResponse.json() as Record<string, unknown> | OnCallIncident[];
  const rawItems = Array.isArray(listPayload)
    ? listPayload
    : (Array.isArray(listPayload.items) ? listPayload.items : Array.isArray(listPayload.incidents) ? listPayload.incidents : []);
  const normalizedItems = (rawItems as Record<string, any>[]).map(normalizeIncident);
  const owner = url.searchParams.get("owner")?.trim().toLowerCase();
  const query = url.searchParams.get("q")?.trim().toLowerCase();
  const items = normalizedItems.filter((incident) =>
    (!owner || (owner === "unowned" ? !incident.owner : incident.owner?.toLowerCase().includes(owner))) &&
    (!query || [incident.id, incident.title, incident.summary, incident.service, incident.owner, ...incident.labels]
      .filter(Boolean).some((value) => String(value).toLowerCase().includes(query)))
  );
  let summary = summaryFromIncidents(normalizedItems);
  if (summaryResponse.ok) {
    const upstreamSummary = await summaryResponse.json() as Record<string, any>;
    summary = {
      ...summary,
      total: Number(upstreamSummary.total ?? summary.total),
      active: Number(upstreamSummary.active ?? upstreamSummary.open ?? summary.active),
      critical: Number(upstreamSummary.critical ?? upstreamSummary.severityCounts?.SEV1 ?? summary.critical),
      unowned: Number(upstreamSummary.unowned ?? upstreamSummary.metrics?.unowned ?? summary.unowned),
      awaitingApproval: Number(upstreamSummary.awaitingApproval ?? upstreamSummary.metrics?.approvalPending ?? summary.awaitingApproval),
      resolved: Number(upstreamSummary.resolved ?? summary.resolved),
      meanAcknowledgeMinutes: Number(upstreamSummary.meanAcknowledgeMinutes ?? upstreamSummary.metrics?.meanAcknowledgeMinutes ?? summary.meanAcknowledgeMinutes),
    };
  }
  return Response.json({ items, total: items.length, summary, source: "impact-engine" });
}

function localList(url: URL) {
  const items = filteredDemoIncidents(url);
  return Response.json({
    items,
    total: items.length,
    summary: summarizeDemoIncidents(),
    source: "console-demo",
  }, { headers: { "x-relaygrid-source": "console-demo" } });
}

function localAction(incidentId: string, action: OnCallActionName, body: Record<string, unknown>) {
  const result = updateDemoIncident(incidentId, action, body);
  if (!result.incident) return Response.json({ error: result.error || "Incident action failed" }, { status: result.status || 400 });
  return Response.json({ incident: result.incident, summary: summarizeDemoIncidents(), source: "console-demo" }, {
    headers: { "x-relaygrid-source": "console-demo" },
  });
}

async function handler(request: Request, context: { params: Promise<RouteParams> }) {
  const { path = [] } = await context.params;
  if (!path.length || path.some((segment) => !/^[a-zA-Z0-9_-]+$/.test(segment))) {
    return Response.json({ error: "Invalid on-call route" }, { status: 400 });
  }
  const url = new URL(request.url);

  if (request.method === "GET" && path.length === 1 && path[0] === "incidents") {
    try {
      return await proxyList(url);
    } catch {
      return localList(url);
    }
  }

  if (request.method === "GET" && path.length === 1 && path[0] === "summary") {
    try {
      const response = await upstream("/summary");
      if (!response.ok) throw new Error("On-call summary unavailable");
      return new Response(await response.text(), { status: response.status, headers: { "content-type": "application/json" } });
    } catch {
      return Response.json({ ...summarizeDemoIncidents(), source: "console-demo" });
    }
  }

  const incidentId = path[0] === "incidents" ? path[1] : undefined;
  if (!incidentId) return Response.json({ error: "On-call route not found" }, { status: 404 });

  if (request.method === "GET" && path.length === 2) {
    try {
      const response = await upstream(`/incidents/${encodeURIComponent(incidentId)}`);
      if (response.status >= 500) throw new Error("On-call engine unavailable");
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) return Response.json(payload, { status: response.status });
      return Response.json({ incident: normalizeIncident((payload.incident ?? payload) as Record<string, any>), source: "impact-engine" });
    } catch {
      const incident = cloneIncidents().find((item) => item.id === incidentId);
      return incident
        ? Response.json({ incident, source: "console-demo" }, { headers: { "x-relaygrid-source": "console-demo" } })
        : Response.json({ error: "Incident not found" }, { status: 404 });
    }
  }

  if (request.method !== "POST" || path.length !== 3) {
    return Response.json({ error: "On-call route not found" }, { status: 404 });
  }

  const action = path[2] as OnCallActionName;
  const allowed: OnCallActionName[] = ["acknowledge", "investigate", "propose-remediation", "approve-remediation", "escalate", "resolve"];
  if (!allowed.includes(action)) return Response.json({ error: "Unsupported incident action" }, { status: 400 });

  if (!requestHasTrustedOrigin(request)) {
    return Response.json({ error: "Untrusted request origin" }, { status: 403 });
  }
  const operatorSession = readOperatorSession(request);
  if (!operatorSession) {
    return Response.json({ error: "Unlock an operator session before changing incident state" }, {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  // Identity is always derived from the signed HttpOnly session. Client supplied
  // actor, owner and approver fields are deliberately overwritten.
  const { actor: _untrustedActor, approvedBy: _untrustedApprover, owner: _untrustedOwner, ...requestFields } = body;
  body = {
    ...requestFields,
    actor: operatorSession.operator,
    ...(action === "acknowledge" ? { owner: operatorSession.operator } : {}),
    ...(action === "approve-remediation" ? { approvedBy: operatorSession.operator } : {}),
  };
  const approvedBy = operatorSession.operator;

  const explicitDemo = body.expectedSource === "console-demo" && process.env.NODE_ENV !== "production";
  if (explicitDemo) return localAction(incidentId, action, body);

  if (action === "propose-remediation" || action === "approve-remediation") {
    const toolName = action === "propose-remediation" ? "prepare_incident_remediation" : "execute_incident_remediation";
    let toolArguments: Record<string, unknown>;
    if (action === "propose-remediation") {
      const remediationAction = typeof body.action === "string" ? body.action : "";
      const rationale = typeof (body.rationale ?? body.summary) === "string" ? String(body.rationale ?? body.summary).trim() : "";
      if (!["pause_robot", "send_to_charging", "clear_robot_anomaly", "reroute_robot"].includes(remediationAction)) {
        return Response.json({ error: "A supported remediation action is required" }, { status: 400 });
      }
      if (rationale.length < 5) return Response.json({ error: "A remediation rationale is required" }, { status: 400 });
      if (remediationAction === "reroute_robot" && typeof body.targetZoneId !== "string") {
        return Response.json({ error: "Rerouting requires a target zone" }, { status: 400 });
      }
      toolArguments = {
        incidentId,
        action: remediationAction,
        rationale,
        ...(typeof body.scope === "string" && body.scope.trim() ? { scope: body.scope.trim() } : {}),
        ...(typeof body.rollback === "string" && body.rollback.trim() ? { rollback: body.rollback.trim() } : {}),
        ...(body.risk === "LOW" || body.risk === "MEDIUM" || body.risk === "HIGH" ? { risk: body.risk } : {}),
        ...(typeof body.targetRobotId === "string" && body.targetRobotId ? { targetRobotId: body.targetRobotId } : {}),
        ...(remediationAction === "reroute_robot" && typeof body.targetZoneId === "string" && body.targetZoneId ? { targetZoneId: body.targetZoneId } : {}),
      };
    } else {
      const actionIntentId = typeof body.intentId === "string" ? body.intentId.trim() : "";
      if (!actionIntentId) return Response.json({ error: "Action intent is required for approval" }, { status: 400 });
      toolArguments = {
        incidentId,
        actionIntentId,
        approvedBy,
        ...(typeof body.approvalNote === "string" && body.approvalNote ? { approvalNote: body.approvalNote } : {}),
      };
    }
    try {
      const payload = await callOperationsTool(toolName, toolArguments);
      const rawIncident = payload.incident;
      if (!rawIncident || typeof rawIncident !== "object") throw new Error("Operations MCP returned no incident state");
      return Response.json({ ...payload, incident: normalizeIncident(rawIncident) });
    } catch (error) {
      return unknownMutation(`Mutation outcome is unknown; reconcile the incident before retrying. ${error instanceof Error ? error.message : "Operations MCP unavailable"}`);
    }
  }

  const lifecyclePath: Partial<Record<OnCallActionName, string>> = {
    acknowledge: `/incidents/${encodeURIComponent(incidentId)}/acknowledge`,
    investigate: `/incidents/${encodeURIComponent(incidentId)}/investigate`,
    escalate: `/incidents/${encodeURIComponent(incidentId)}/escalate`,
    resolve: `/incidents/${encodeURIComponent(incidentId)}/resolve`,
  };
  const upstreamPath = lifecyclePath[action];
  if (!upstreamPath) return Response.json({ error: "Unsupported incident action" }, { status: 400 });
  const upstreamBody = { ...body };
  delete upstreamBody.expectedSource;
  try {
    const response = await upstream(upstreamPath, "POST", upstreamBody);
    const payload = await response.json().catch(() => ({})) as Record<string, any>;
    if (response.status >= 500) throw new Error(`control plane returned ${response.status}`);
    if (!response.ok) {
      return Response.json({ ...payload, error: typeof payload.detail === "string" ? payload.detail : payload.error }, { status: response.status });
    }
    const rawIncident = payload.incident ?? payload;
    return Response.json({ incident: normalizeIncident(rawIncident), source: "impact-engine" });
  } catch (error) {
    return unknownMutation(`Mutation outcome is unknown; reconcile the incident before retrying. ${error instanceof Error ? error.message : "Control plane unavailable"}`);
  }
}

export const GET = handler;
export const POST = handler;
