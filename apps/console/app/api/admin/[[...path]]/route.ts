import { demoState, updateDemoAction } from "@/lib/demo-store";
import type { ProoflineAction } from "@/lib/types";

export const dynamic = "force-dynamic";

type AdminAction = {
  actionId: string;
  idempotencyKey: string;
  actionType: string;
  targetRef: string;
  request: ProoflineAction["request"];
  state: string;
  approvedBy?: string | null;
  approvedAt?: string | null;
  rejectedBy?: string | null;
  rejectedAt?: string | null;
  rejectionReason?: string | null;
  createdAt: string;
  updatedAt: string;
};

type RouteParams = { path?: string[] };

type DemoEvent = {
  eventId: number;
  eventType: string;
  actor: string;
  details: Record<string, unknown>;
  createdAt: string;
};

function demoAction(action: ProoflineAction): AdminAction {
  const approved = action.state === "READY" || action.state === "APPLIED";
  const rejected = action.state === "REJECTED";
  return {
    actionId: action.action_id,
    idempotencyKey: `demo:${action.action_id}`,
    actionType: action.action_type,
    targetRef: action.target_ref,
    request: action.request,
    state: action.state,
    approvedBy: action.approved_by,
    approvedAt: approved ? action.updated_at : null,
    rejectedBy: rejected ? "alex@northstar.local" : null,
    rejectedAt: rejected ? action.updated_at : null,
    rejectionReason: action.rejection_reason,
    createdAt: action.created_at,
    updatedAt: action.updated_at,
  };
}

function demoHistory(action: AdminAction) {
  const events: DemoEvent[] = [{
    eventId: 1,
    eventType: "INTENT_CREATED",
    actor: "service:control-plane",
    details: { actionType: action.actionType, targetRef: action.targetRef },
    createdAt: action.createdAt,
  }];
  if (action.state === "READY" || action.state === "APPLIED") {
    events.push({
      eventId: 2,
      eventType: "APPROVED",
      actor: action.approvedBy || "alex@northstar.local",
      details: { note: "Approved from the RelayGrid operations console" },
      createdAt: action.updatedAt,
    });
  }
  if (action.state === "REJECTED") {
    events.push({
      eventId: 2,
      eventType: "REJECTED",
      actor: action.rejectedBy || "alex@northstar.local",
      details: { reason: action.rejectionReason || "Rejected by operator" },
      createdAt: action.updatedAt,
    });
  }
  return events;
}

function demoResponse(method: string, path: string[], url: URL, body?: Record<string, unknown>) {
  const actions = demoState().actions;
  if (method === "GET" && path.length === 1 && path[0] === "actions") {
    const state = url.searchParams.get("state")?.trim();
    const actionType = url.searchParams.get("actionType")?.trim().toLowerCase();
    const targetRef = url.searchParams.get("targetRef")?.trim().toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const filtered = actions.map(demoAction).filter((action) =>
      (!state || action.state === state) &&
      (!actionType || action.actionType.toLowerCase() === actionType) &&
      (!targetRef || action.targetRef.toLowerCase().includes(targetRef))
    );
    return Response.json({ items: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset, source: "console-demo" });
  }

  if (method === "GET" && path.join("/") === "actions/summary") {
    const counts = actions.reduce<Record<string, number>>((result, action) => {
      result[action.state] = (result[action.state] || 0) + 1;
      return result;
    }, {});
    return Response.json({
      total: actions.length,
      pendingApproval: counts.PENDING_APPROVAL || 0,
      ready: counts.READY || 0,
      applied: counts.APPLIED || 0,
      rejected: counts.REJECTED || 0,
      needsAttention: (counts.NOT_APPLIED || 0) + (counts.UNKNOWN || 0),
      updatedLast24Hours: actions.filter((action) => Date.now() - Date.parse(action.updated_at) <= 86_400_000).length,
      source: "console-demo",
    });
  }

  const actionId = path[1];
  if (path[0] !== "actions" || !actionId) {
    return Response.json({ error: "Admin route not found" }, { status: 404 });
  }

  if (method === "GET" && path.length === 2) {
    const found = actions.find((item) => item.action_id === actionId);
    if (!found) return Response.json({ error: "Action intent not found" }, { status: 404 });
    const action = demoAction(found);
    return Response.json({ action, history: demoHistory(action), source: "console-demo" });
  }

  const decision = path[2];
  if (method === "POST" && path.length === 3 && (decision === "approve" || decision === "reject")) {
    const actor = typeof body?.actor === "string" ? body.actor.trim() : "";
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!actor) return Response.json({ error: "Actor is required" }, { status: 400 });
    if (decision === "reject" && !reason) return Response.json({ error: "Rejection reason is required" }, { status: 400 });
    const current = actions.find((item) => item.action_id === actionId);
    if (!current) return Response.json({ error: "Action intent not found" }, { status: 404 });
    if (current.state !== "PENDING_APPROVAL") return Response.json({ error: "Action is no longer awaiting approval" }, { status: 409 });
    const changed = updateDemoAction(actionId, decision, reason);
    if (!changed) return Response.json({ error: "Action intent not found" }, { status: 404 });
    const action = demoAction(changed);
    if (decision === "approve") action.approvedBy = actor;
    if (decision === "reject") action.rejectedBy = actor;
    return Response.json({ action, history: demoHistory(action), source: "console-demo" });
  }

  return Response.json({ error: "Admin route not found" }, { status: 404 });
}

async function handler(request: Request, context: { params: Promise<RouteParams> }) {
  const { path = [] } = await context.params;
  if (!path.length || path.some((segment) => !/^[a-zA-Z0-9_-]+$/.test(segment))) {
    return Response.json({ error: "Invalid admin route" }, { status: 400 });
  }

  const url = new URL(request.url);
  let body: Record<string, unknown> | undefined;
  if (request.method === "POST") {
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
    }
  }

  const prooflineUrl = process.env.PROOFLINE_URL?.replace(/\/$/, "");
  const prooflineToken = process.env.PROOFLINE_INTERNAL_TOKEN;
  if (prooflineUrl && prooflineToken) {
    try {
      const upstream = await fetch(`${prooflineUrl}/v1/admin/${path.join("/")}${url.search}`, {
        method: request.method,
        headers: {
          "content-type": "application/json",
          "X-Proofline-Token": prooflineToken,
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(900),
      });
      if (upstream.status < 500) {
        const payload = await upstream.text();
        return new Response(payload, {
          status: upstream.status,
          headers: { "content-type": upstream.headers.get("content-type") || "application/json" },
        });
      }
    } catch {
      // Proofline is optional in local development. The in-process demo ledger
      // preserves the same API contract so approval interactions stay usable.
    }
  }

  return demoResponse(request.method, path, url, body);
}

export const GET = handler;
export const POST = handler;
