import { demoState } from "@/lib/demo-store";

const controlPlane = process.env.CONTROL_PLANE_URL ?? "http://localhost:8084";

export async function POST(request: Request) {
  const payload = await request.json();
  try {
    const response = await fetch(`${controlPlane}/v1/tracehold/recalls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (response.status >= 500) {
      throw new Error(`Control plane unavailable (${response.status})`);
    }
    const data = await response.json();
    return Response.json(data, { status: response.status });
  } catch {
    const lotIds = Array.isArray(payload.lotIds) ? payload.lotIds : [];
    const catalogue = [
      { lotId: "LOT-0001", sku: "RADIO-82", productName: "Relay Radio Module", onHandUnits: 420, status: "available", affectedOrders: 2, orderedUnits: 3 },
      { lotId: "LOT-0002", sku: "CAM-14", productName: "Compact Camera Board", onHandUnits: 86, status: "available", affectedOrders: 1, orderedUnits: 3 },
    ];
    const lots = catalogue.filter((lot) => lotIds.includes(lot.lotId));
    const missingLotIds = lotIds.filter((id: string) => !catalogue.some((lot) => lot.lotId === id));
    const actionPreviews = demoState().actions.filter((action) => lots.some((lot) => lot.lotId === action.target_ref)).map((action) => ({ action_id: action.action_id, action_type: action.action_type, target_ref: action.target_ref, state: action.state }));
    return Response.json({
      recallId: payload.recallId,
      phase: "awaiting_operator_review",
      runbook: { name: "TraceHold supplier recall containment", version: 1 },
      impact: { lots, missingLotIds, requiresOperatorReview: missingLotIds.length > 0 || lots.some((lot) => lot.affectedOrders > 0) },
      actionPreviews,
      nextStep: "Review Proofline intents in Approvals. Inventory remains unchanged until an operator approves and TrueForge dispatches the MCP tool.",
      source: "console-demo",
    }, { status: 202, headers: { "x-relaygrid-source": "console-demo" } });
  }
}
