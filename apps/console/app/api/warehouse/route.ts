import { tickDemo, updateDemoWarehouse } from "@/lib/demo-store";

const engineBase = process.env.WAREHOUSE_ENGINE_URL ?? process.env.IMPACT_ENGINE_URL ?? "http://localhost:8002";

function normalizeSnapshot(snapshot: Record<string, any>, source: "warehouse-engine" | "console-demo" = "warehouse-engine") {
  const robotState: Record<string, string> = { executing: "moving", ready: "idle" };
  const severity: Record<string, string> = { info: "low", warning: "medium", critical: "high" };
  return {
    ...snapshot,
    robots: (snapshot.robots ?? []).map((robot: Record<string, any>) => ({
      ...robot,
      state: robotState[robot.state] ?? robot.state,
      target: robot.target && typeof robot.target === "object"
        ? `Grid ${robot.target.x}, ${robot.target.y}`
        : robot.target,
    })),
    missions: (snapshot.missions ?? []).map((mission: Record<string, any>) => ({
      ...mission,
      status: mission.status === "completed" ? "complete" : mission.status,
    })),
    anomalies: (snapshot.anomalies ?? []).map((anomaly: Record<string, any>) => ({
      ...anomaly,
      severity: severity[anomaly.severity] ?? anomaly.severity,
    })),
    activity: (snapshot.activity ?? []).map((item: Record<string, any>) => ({
      ...item,
      kind: item.kind ?? item.type ?? "operation",
    })),
    source,
  };
}

async function engineSnapshot() {
  const response = await fetch(`${engineBase}/v1/warehouse/snapshot`, { cache: "no-store", signal: AbortSignal.timeout(900) });
  if (!response.ok) throw new Error(`warehouse engine returned ${response.status}`);
  return response.json();
}

export async function GET() {
  try {
    return Response.json(normalizeSnapshot(await engineSnapshot()));
  } catch {
    return Response.json(tickDemo(), { headers: { "x-relaygrid-source": "console-demo" } });
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";
  const pathByAction: Record<string, string> = {
    tick: "/v1/warehouse/demo/tick",
    toggle: "/v1/warehouse/demo/toggle",
    create_order: "/v1/warehouse/demo/orders",
    inject_anomaly: "/v1/warehouse/demo/anomalies",
    reset: "/v1/warehouse/demo/reset",
  };
  try {
    const path = action === "robot" && typeof body.robotId === "string"
      ? `/v1/warehouse/robots/${encodeURIComponent(body.robotId)}/actions`
      : pathByAction[action];
    if (!path) return Response.json({ error: "unsupported_action" }, { status: 400 });
    let upstreamBody: Record<string, unknown> = body;
    if (action === "robot") upstreamBody = { action: body.command };
    if (action === "tick") upstreamBody = { steps: 1 };
    const response = await fetch(`${engineBase}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(1400),
    });
    if (!response.ok) throw new Error(`warehouse engine returned ${response.status}`);
    const result = await response.json();
    if (result.warehouse && result.robots) return Response.json(normalizeSnapshot(result));
    return Response.json(normalizeSnapshot(await engineSnapshot()));
  } catch {
    return Response.json(updateDemoWarehouse(action, body), { headers: { "x-relaygrid-source": "console-demo" } });
  }
}
