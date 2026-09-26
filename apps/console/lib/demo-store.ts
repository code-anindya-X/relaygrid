import type {
  OnCallActionName,
  OnCallIncident,
  OnCallSummary,
  ProoflineAction,
  WarehouseSnapshot,
} from "./types";

type DemoState = {
  snapshot: WarehouseSnapshot;
  actions: ProoflineAction[];
  incidents: OnCallIncident[];
  lastTick: number;
};

declare global {
  var relayGridDemoState: DemoState | undefined;
}

const baseRoute = [
  { x: 6, y: 7 }, { x: 13, y: 7 }, { x: 13, y: 19 },
  { x: 30, y: 19 }, { x: 30, y: 32 }, { x: 51, y: 32 },
];

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function makeIncidents(): OnCallIncident[] {
  return [
    {
      id: "INC-2048",
      title: "Dispatch flow stalled across aisle C",
      summary: "Eighteen fulfilment missions stopped receiving route acknowledgements after AGV-02 reported an unexpected obstacle.",
      severity: "SEV1",
      status: "OPEN",
      service: "Fleet Orchestrator",
      source: "Sentinel agent",
      createdAt: minutesAgo(7),
      updatedAt: minutesAgo(2),
      slaMinutes: 10,
      labels: ["warehouse", "fleet", "dispatch"],
      impact: {
        headline: "18 missions stalled; outbound SLA breach expected in 21 minutes",
        ordersAtRisk: 47,
        robotsAffected: 3,
        zonesAffected: ["Aisle C", "Packing"],
      },
      evidence: [
        { id: "EV-2048-1", kind: "signal", title: "Dispatch acknowledgement rate collapsed", detail: "Route acknowledgements fell from 99.7% to 31.4% in a two minute window.", source: "Fleet telemetry", createdAt: minutesAgo(7), confidence: 0.99 },
        { id: "EV-2048-2", kind: "log", title: "Obstacle sensor held route lock", detail: "AGV-02 reported obstacle_present=true at grid 24,18 for 96 seconds.", source: "AGV-02 controller", createdAt: minutesAgo(5), confidence: 0.96 },
        { id: "EV-2048-3", kind: "agent", title: "Shared route segment correlated", detail: "Sentinel linked 18 stalled missions to the same aisle C route lock. No inventory writes were attempted.", source: "Sentinel agent", createdAt: minutesAgo(2), confidence: 0.93 },
      ],
      runbook: {
        name: "Fleet dispatch degradation",
        version: "3.2",
        steps: [
          { id: "RB-2048-1", title: "Validate the signal", description: "Correlate dispatch latency with robot and route telemetry.", status: "complete", evidenceIds: ["EV-2048-1", "EV-2048-2"] },
          { id: "RB-2048-2", title: "Acknowledge and establish ownership", description: "Name an incident owner before any physical action is proposed.", status: "active" },
          { id: "RB-2048-3", title: "Inspect the bounded blast radius", description: "Identify robots, missions, and zones sharing the locked route.", status: "pending" },
          { id: "RB-2048-4", title: "Approve a safe remediation", description: "Review scope, risk, and rollback before dispatching a fleet command.", status: "pending", requiresApproval: true },
          { id: "RB-2048-5", title: "Verify recovery", description: "Confirm acknowledgements and throughput return to their baseline.", status: "pending" },
        ],
      },
      escalations: [],
    },
    {
      id: "INC-2047",
      title: "Recall containment is drifting behind new orders",
      summary: "TraceHold found new allocations for a supplier lot while its quarantine intent waits for operator review.",
      severity: "SEV2",
      status: "ACKNOWLEDGED",
      service: "TraceHold Recall",
      source: "Impact agent",
      owner: "Priya Nair",
      commander: "Alex Sharma",
      createdAt: minutesAgo(34),
      updatedAt: minutesAgo(9),
      acknowledgedAt: minutesAgo(29),
      slaMinutes: 30,
      labels: ["recall", "inventory", "approval"],
      impact: {
        headline: "LOT-0001 appears in 6 unfulfilled orders while quarantine approval is pending",
        ordersAtRisk: 6,
        robotsAffected: 1,
        zonesAffected: ["Electronics", "Packing"],
      },
      evidence: [
        { id: "EV-2047-1", kind: "signal", title: "Allocation after recall intake", detail: "Six orders reference LOT-0001 after supplier notice SUP-2026-1042 was received.", source: "Impact engine", createdAt: minutesAgo(34), confidence: 0.98 },
        { id: "EV-2047-2", kind: "operator", title: "Incident acknowledged", detail: "Priya Nair accepted ownership and froze automated replenishment recommendations.", source: "On-call console", createdAt: minutesAgo(29) },
        { id: "EV-2047-3", kind: "action", title: "Proofline intent remains bounded", detail: "Quarantine intent targets LOT-0001 only and is still awaiting approval.", source: "Proofline", createdAt: minutesAgo(9), confidence: 1 },
      ],
      runbook: {
        name: "TraceHold recall containment",
        version: "1.4",
        steps: [
          { id: "RB-2047-1", title: "Validate supplier notice", description: "Match the notice, lot, SKU, and warehouse records.", status: "complete" },
          { id: "RB-2047-2", title: "Map active exposure", description: "Find on-hand units, allocations, missions, and customer orders.", status: "active" },
          { id: "RB-2047-3", title: "Prepare quarantine intent", description: "Create a lot-scoped Proofline action without mutating inventory.", status: "pending" },
          { id: "RB-2047-4", title: "Operator approval", description: "A human reviews evidence before the quarantine tool is called.", status: "pending", requiresApproval: true },
          { id: "RB-2047-5", title: "Verify containment", description: "Recalculate impact and confirm no affected order can progress.", status: "pending" },
        ],
      },
      escalations: [],
    },
    {
      id: "INC-2046",
      title: "Battery reserve cascade threatens packing flow",
      summary: "Three robots will cross their safe route reserve before completing queued missions. A bounded charging plan is ready for review.",
      severity: "SEV2",
      status: "AWAITING_APPROVAL",
      service: "Fleet Energy",
      source: "Sentinel agent",
      owner: "Alex Sharma",
      createdAt: minutesAgo(52),
      updatedAt: minutesAgo(4),
      acknowledgedAt: minutesAgo(47),
      slaMinutes: 30,
      labels: ["fleet", "battery", "approval"],
      impact: {
        headline: "3 robots and 11 missions exposed; packing capacity may fall by 38%",
        ordersAtRisk: 23,
        robotsAffected: 3,
        zonesAffected: ["Packing", "Charging"],
      },
      evidence: [
        { id: "EV-2046-1", kind: "metric", title: "Safe reserve forecast breached", detail: "AGV-03 is predicted at 8% reserve on arrival; AGV-01 and AGV-02 follow within 14 minutes.", source: "Energy predictor", createdAt: minutesAgo(52), confidence: 0.91 },
        { id: "EV-2046-2", kind: "agent", title: "Charging sequence simulated", detail: "The plan preserves two active pick lanes and moves one robot at a time to the charging zone.", source: "Sentinel agent", createdAt: minutesAgo(11), confidence: 0.89 },
        { id: "EV-2046-3", kind: "action", title: "Remediation proposed", detail: "A scoped send-to-charging command is awaiting human approval.", source: "On-call console", createdAt: minutesAgo(4) },
      ],
      runbook: {
        name: "Fleet energy reserve recovery",
        version: "2.1",
        steps: [
          { id: "RB-2046-1", title: "Validate reserve forecast", description: "Compare battery telemetry with remaining route cost.", status: "complete" },
          { id: "RB-2046-2", title: "Simulate mission reassignment", description: "Keep a minimum of two packing lanes supplied.", status: "complete" },
          { id: "RB-2046-3", title: "Review charging command", description: "Approve the robot-scoped physical action and rollback plan.", status: "active", requiresApproval: true },
          { id: "RB-2046-4", title: "Execute in sequence", description: "Send the first robot to charging and observe packing throughput.", status: "pending" },
          { id: "RB-2046-5", title: "Verify reserve recovery", description: "Confirm all active routes retain their safe reserve.", status: "pending" },
        ],
      },
      remediation: {
        id: "REM-2046-1",
        summary: "Stage one robot at a time through the charging zone",
        action: "send_to_charging",
        scope: "AGV-03 first; AGV-01 and AGV-02 remain on current missions",
        rollback: "Resume AGV-03 and restore its previous mission assignment",
        risk: "MEDIUM",
        status: "PROPOSED",
        proposedBy: "Sentinel agent",
        proposedAt: minutesAgo(4),
      },
      escalations: [],
    },
    {
      id: "INC-2043",
      title: "Operations MCP read latency exceeded budget",
      summary: "Warehouse snapshot reads slowed after a local connection pool reset and recovered without a physical write.",
      severity: "SEV3",
      status: "RESOLVED",
      service: "Operations MCP",
      source: "Runtime monitor",
      owner: "Marco Lee",
      createdAt: minutesAgo(198),
      updatedAt: minutesAgo(126),
      acknowledgedAt: minutesAgo(191),
      resolvedAt: minutesAgo(126),
      slaMinutes: 60,
      labels: ["mcp", "latency", "recovered"],
      impact: {
        headline: "Read latency reached 2.4 seconds for 4 minutes; no commands were delayed",
        ordersAtRisk: 0,
        robotsAffected: 0,
        zonesAffected: [],
      },
      evidence: [
        { id: "EV-2043-1", kind: "metric", title: "Read latency alert", detail: "p95 warehouse_snapshot latency crossed the 900ms budget.", source: "Runtime monitor", createdAt: minutesAgo(198), confidence: 1 },
        { id: "EV-2043-2", kind: "operator", title: "Connection pool inspected", detail: "No stuck sessions or command retries were found.", source: "On-call console", createdAt: minutesAgo(173) },
        { id: "EV-2043-3", kind: "signal", title: "Service recovered", detail: "p95 remained below 300ms for 30 consecutive minutes.", source: "Runtime monitor", createdAt: minutesAgo(126), confidence: 1 },
      ],
      runbook: {
        name: "MCP latency recovery",
        version: "1.3",
        steps: [
          { id: "RB-2043-1", title: "Validate latency", description: "Compare MCP, engine, and database timings.", status: "complete" },
          { id: "RB-2043-2", title: "Inspect dependencies", description: "Check health and connection pool saturation.", status: "complete" },
          { id: "RB-2043-3", title: "Observe recovery", description: "Hold the incident until latency is stable for 30 minutes.", status: "complete" },
        ],
      },
      escalations: [],
    },
  ];
}

function makeState(): DemoState {
  const now = new Date().toISOString();
  return {
    lastTick: Date.now(),
    incidents: makeIncidents(),
    snapshot: {
      warehouse: { id: "WH-BLR-01", name: "Northstar Fulfilment · Bengaluru", width: 60, depth: 40, running: true, mode: "DEMO LIVE", lastUpdated: now },
      zones: [
        { id: "receiving", name: "Receiving", type: "receiving", x: 2, y: 2, width: 12, depth: 6, color: "#b6d8c9", inventoryUnits: 382 },
        { id: "electronics", name: "Electronics", type: "storage", x: 18, y: 3, width: 11, depth: 13, color: "#c9dfd5", inventoryUnits: 1840 },
        { id: "smart-home", name: "Smart home", type: "storage", x: 33, y: 3, width: 11, depth: 13, color: "#dce9df", inventoryUnits: 964 },
        { id: "wellness", name: "Health & wellness", type: "storage", x: 48, y: 3, width: 10, depth: 13, color: "#e8ddca", inventoryUnits: 714 },
        { id: "photo", name: "Photo & audio", type: "storage", x: 18, y: 21, width: 12, depth: 8, color: "#d8e4d9", inventoryUnits: 623 },
        { id: "garden", name: "Home & garden", type: "storage", x: 34, y: 21, width: 11, depth: 8, color: "#e3e8cf", inventoryUnits: 520 },
        { id: "packing", name: "Packing", type: "packing", x: 3, y: 32, width: 15, depth: 6, color: "#eadfcf", inventoryUnits: 91 },
        { id: "shipping", name: "Shipping", type: "shipping", x: 22, y: 32, width: 15, depth: 6, color: "#dedbed", inventoryUnits: 44 },
        { id: "charging", name: "Charging", type: "charging", x: 47, y: 32, width: 11, depth: 6, color: "#d9e8df", inventoryUnits: 4 },
      ],
      robots: [
        { id: "AGV-01", name: "Atlas", x: 7, y: 10, heading: 0, battery: 87, state: "moving", currentMissionId: "MIS-2041", target: "Electronics" },
        { id: "AGV-02", name: "Milo", x: 24, y: 18, heading: 90, battery: 64, state: "picking", currentMissionId: "MIS-2042", target: "Packing" },
        { id: "AGV-03", name: "Nova", x: 39, y: 18, heading: 180, battery: 38, state: "moving", currentMissionId: "MIS-2043", target: "Charging" },
        { id: "AGV-04", name: "Pico", x: 51, y: 34, heading: 270, battery: 96, state: "charging", target: "Charging" },
      ],
      missions: [
        { id: "MIS-2041", orderRef: "ORD-62041", robotId: "AGV-01", status: "active", stage: "Pick", progress: 42, route: baseRoute },
        { id: "MIS-2042", orderRef: "ORD-62077", robotId: "AGV-02", status: "active", stage: "Transport", progress: 68, route: [{ x: 24, y: 18 }, { x: 24, y: 30 }, { x: 11, y: 34 }] },
        { id: "MIS-2043", orderRef: "ORD-62102", robotId: "AGV-03", status: "active", stage: "Replenish", progress: 21, route: [{ x: 39, y: 18 }, { x: 46, y: 18 }, { x: 52, y: 34 }] },
      ],
      anomalies: [
        { id: "ANO-118", severity: "medium", type: "battery", message: "Nova will need a charging slot after this mission.", robotId: "AGV-03", createdAt: now },
      ],
      kpis: { robotsOnline: 4, activeMissions: 3, ordersToday: 186, avgPickMinutes: 4.8 },
      activity: [
        { id: "EV-1", message: "Atlas accepted ORD-62041", createdAt: now, kind: "mission" },
        { id: "EV-2", message: "Proofline approval requested for LOT-0001", createdAt: now, kind: "approval" },
      ],
      source: "console-demo",
    },
    actions: [
      { action_id: "c23033ad-c16f-41ad-8d9e-3190bd667201", action_type: "quarantine_lot", target_ref: "LOT-0001", state: "PENDING_APPROVAL", request: { recallId: "SUP-2026-1042", supplier: "Acme Components", lotId: "LOT-0001", reason: "Supplier reports thermal instability" }, created_at: now, updated_at: now },
      { action_id: "62f1a5bf-9a1c-4f9f-b17c-e93633372a45", action_type: "pause_robot", target_ref: "AGV-03", state: "PENDING_APPROVAL", request: { reason: "Battery prediction below safe route reserve", blastRadius: "1 active mission" }, created_at: now, updated_at: now },
      { action_id: "052fab13-f2cb-499a-a18f-2af5d889d83e", action_type: "quarantine_lot", target_ref: "LOT-0002", state: "APPLIED", request: { recallId: "SUP-2026-0998", lotId: "LOT-0002", reason: "Packaging seal failure" }, approved_by: "alex@northstar.local", created_at: new Date(Date.now() - 86_400_000).toISOString(), updated_at: now },
    ],
  };
}

export function demoState(): DemoState {
  globalThis.relayGridDemoState ??= makeState();
  if (!Array.isArray(globalThis.relayGridDemoState.incidents)) {
    globalThis.relayGridDemoState.incidents = makeIncidents();
  }
  return globalThis.relayGridDemoState;
}

export function summarizeDemoIncidents(incidents = demoState().incidents): OnCallSummary {
  const active = incidents.filter((incident) => incident.status !== "RESOLVED");
  const acknowledged = incidents.filter((incident) => incident.acknowledgedAt);
  const acknowledgeMinutes = acknowledged.map((incident) =>
    Math.max(0, (Date.parse(incident.acknowledgedAt!) - Date.parse(incident.createdAt)) / 60_000)
  );
  return {
    total: incidents.length,
    active: active.length,
    critical: active.filter((incident) => incident.severity === "SEV1").length,
    unowned: active.filter((incident) => !incident.owner).length,
    awaitingApproval: active.filter((incident) => incident.status === "AWAITING_APPROVAL").length,
    resolved: incidents.filter((incident) => incident.status === "RESOLVED").length,
    meanAcknowledgeMinutes: acknowledgeMinutes.length
      ? Number((acknowledgeMinutes.reduce((sum, value) => sum + value, 0) / acknowledgeMinutes.length).toFixed(1))
      : 0,
  };
}

type DemoIncidentResult = {
  incident?: OnCallIncident;
  error?: string;
  status?: number;
};

function advanceRunbook(incident: OnCallIncident, approvalStep = false) {
  const steps = incident.runbook.steps;
  const index = approvalStep
    ? steps.findIndex((step) => step.requiresApproval && step.status !== "complete")
    : steps.findIndex((step) => step.status === "active");
  if (index < 0) return;
  steps[index].status = "complete";
  const next = steps.slice(index + 1).find((step) => step.status === "pending");
  if (next) next.status = "active";
}

export function updateDemoIncident(
  incidentId: string,
  action: OnCallActionName,
  payload: Record<string, unknown> = {},
): DemoIncidentResult {
  const incident = demoState().incidents.find((item) => item.id === incidentId);
  if (!incident) return { error: "Incident not found", status: 404 };
  if (incident.status === "RESOLVED" && action !== "resolve") {
    return { error: "Resolved incidents are read-only", status: 409 };
  }

  const now = new Date().toISOString();
  const actorValue = action === "approve-remediation" ? payload.approvedBy : payload.actor;
  const actor = typeof actorValue === "string" && actorValue.trim() ? actorValue.trim() : "Alex Sharma";
  const addEvidence = (kind: "agent" | "operator" | "action", title: string, detail: string, source = "On-call console") => {
    incident.evidence.push({
      id: `EV-${incident.id.replace("INC-", "")}-${Date.now()}`,
      kind,
      title,
      detail,
      source,
      createdAt: now,
    });
  };

  if (action === "acknowledge") {
    if (incident.acknowledgedAt) return { error: "Incident is already acknowledged", status: 409 };
    incident.owner = typeof payload.owner === "string" && payload.owner.trim() ? payload.owner.trim() : actor;
    incident.acknowledgedAt = now;
    incident.status = "ACKNOWLEDGED";
    advanceRunbook(incident);
    addEvidence("operator", "Incident acknowledged", `${incident.owner} accepted ownership and started the response clock.`);
  }

  if (action === "investigate") {
    if (!incident.acknowledgedAt) {
      incident.acknowledgedAt = now;
      incident.owner = actor;
    }
    incident.status = "INVESTIGATING";
    advanceRunbook(incident);
    const note = typeof payload.note === "string" && payload.note.trim()
      ? payload.note.trim()
      : "Correlated current telemetry, recent actions, and affected warehouse entities.";
    addEvidence("agent", "Investigation evidence collected", note, "Sentinel agent");
  }

  if (action === "propose-remediation") {
    const required = ["summary", "action", "scope", "rollback"] as const;
    const missing = required.find((field) => typeof payload[field] !== "string" || !payload[field]?.toString().trim());
    if (missing) return { error: `${missing} is required`, status: 400 };
    incident.remediation = {
      id: `REM-${incident.id.replace("INC-", "")}-${Date.now().toString().slice(-4)}`,
      summary: String(payload.summary).trim(),
      action: String(payload.action).trim(),
      scope: String(payload.scope).trim(),
      rollback: String(payload.rollback).trim(),
      risk: payload.risk === "LOW" || payload.risk === "HIGH" ? payload.risk : "MEDIUM",
      status: "PROPOSED",
      proposedBy: actor,
      proposedAt: now,
    };
    incident.status = "AWAITING_APPROVAL";
    incident.runbook.steps.forEach((step) => {
      if (step.requiresApproval && step.status !== "complete") step.status = "active";
      else if (step.status === "active") step.status = "complete";
    });
    addEvidence("action", "Remediation proposed", `${incident.remediation.summary} Scope: ${incident.remediation.scope}.`);
  }

  if (action === "approve-remediation") {
    if (!incident.remediation) return { error: "No remediation is ready for approval", status: 409 };
    if (incident.remediation.status !== "PROPOSED") return { error: "Remediation is no longer awaiting approval", status: 409 };
    incident.remediation.status = "APPROVED";
    incident.remediation.approvedBy = actor;
    incident.remediation.approvedAt = now;
    incident.status = "REMEDIATING";
    advanceRunbook(incident, true);
    const note = typeof payload.approvalNote === "string" && payload.approvalNote.trim()
      ? ` ${payload.approvalNote.trim()}`
      : "";
    addEvidence("operator", "Bounded remediation approved", `${actor} approved ${incident.remediation.action}.${note}`);
  }

  if (action === "escalate") {
    const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
    if (!reason) return { error: "Escalation reason is required", status: 400 };
    const target = typeof payload.target === "string" && payload.target.trim() ? payload.target.trim() : "Site reliability lead";
    incident.escalations.push({ id: `ESC-${Date.now()}`, target, reason, actor, createdAt: now });
    incident.status = "ESCALATED";
    if (!incident.owner) incident.owner = actor;
    addEvidence("operator", `Escalated to ${target}`, reason);
  }

  if (action === "resolve") {
    const resolutionNote = typeof payload.resolutionNote === "string" ? payload.resolutionNote.trim() : "";
    if (!resolutionNote) return { error: "Resolution note is required", status: 400 };
    incident.status = "RESOLVED";
    incident.resolvedAt = now;
    if (!incident.owner) incident.owner = actor;
    if (incident.remediation?.status === "APPROVED" || incident.remediation?.status === "EXECUTING") {
      incident.remediation.status = "EXECUTED";
    }
    incident.runbook.steps.forEach((step) => { step.status = "complete"; });
    addEvidence("operator", "Incident resolved", resolutionNote);
  }

  incident.updatedAt = now;
  return { incident: structuredClone(incident) };
}

export function tickDemo(): WarehouseSnapshot {
  const state = demoState();
  const now = Date.now();
  const seconds = Math.max(0.4, Math.min(4, (now - state.lastTick) / 1000));
  state.lastTick = now;
  if (state.snapshot.warehouse.running) {
    state.snapshot.robots = state.snapshot.robots.map((robot, index) => {
      if (robot.state !== "moving") return robot;
      const angle = (now / 2600) + index * 1.7;
      const nextX = Math.max(2, Math.min(58, robot.x + Math.cos(angle) * seconds * 0.9));
      const nextY = Math.max(2, Math.min(38, robot.y + Math.sin(angle) * seconds * 0.65));
      return { ...robot, x: Number(nextX.toFixed(2)), y: Number(nextY.toFixed(2)), heading: Number(((angle * 180 / Math.PI) % 360).toFixed(1)), battery: Math.max(8, Number((robot.battery - seconds * 0.015).toFixed(1))) };
    });
    state.snapshot.missions = state.snapshot.missions.map((mission) => mission.status === "active" ? { ...mission, progress: Math.min(99, Number((mission.progress + seconds * 0.35).toFixed(1))) } : mission);
  }
  state.snapshot.warehouse.lastUpdated = new Date(now).toISOString();
  state.snapshot.kpis.activeMissions = state.snapshot.missions.filter((mission) => mission.status === "active").length;
  return structuredClone(state.snapshot);
}

export function updateDemoWarehouse(action: string, payload: Record<string, unknown> = {}): WarehouseSnapshot {
  const state = demoState();
  const now = new Date().toISOString();
  if (action === "toggle") state.snapshot.warehouse.running = !state.snapshot.warehouse.running;
  if (action === "reset") globalThis.relayGridDemoState = makeState();
  if (action === "create_order") {
    const serial = state.snapshot.kpis.ordersToday + 1;
    state.snapshot.kpis.ordersToday = serial;
    const robot = state.snapshot.robots.find((item) => item.state === "idle") ?? state.snapshot.robots[0];
    const id = `MIS-${2200 + state.snapshot.missions.length}`;
    state.snapshot.missions.push({ id, orderRef: `ORD-${63000 + serial}`, robotId: robot.id, status: "queued", stage: "Assigned", progress: 0, route: baseRoute });
    state.snapshot.activity.unshift({ id: `EV-${Date.now()}`, message: `${robot.name} assigned a new fulfilment mission`, createdAt: now, kind: "mission" });
  }
  if (action === "inject_anomaly") {
    const robot = state.snapshot.robots[1];
    robot.state = "blocked";
    const anomaly = { id: `ANO-${Date.now().toString().slice(-4)}`, severity: "high" as const, type: "route_blockage", message: `${robot.name} detected an unexpected obstacle in aisle C.`, robotId: robot.id, createdAt: now };
    state.snapshot.anomalies.unshift(anomaly);
    state.snapshot.activity.unshift({ id: `EV-${Date.now()}`, message: anomaly.message, createdAt: now, kind: "anomaly" });
  }
  if (action === "robot") {
    const robot = state.snapshot.robots.find((item) => item.id === payload.robotId);
    if (robot && typeof payload.command === "string") {
      if (payload.command === "pause") robot.state = "paused";
      if (payload.command === "resume") robot.state = "moving";
      if (payload.command === "charge") { robot.state = "charging"; robot.target = "Charging"; }
      if (payload.command === "clear_anomaly") { robot.state = "idle"; state.snapshot.anomalies = state.snapshot.anomalies.filter((item) => item.robotId !== robot.id); }
      state.snapshot.activity.unshift({ id: `EV-${Date.now()}`, message: `${robot.name}: ${payload.command}`, createdAt: now, kind: "robot" });
    }
  }
  return tickDemo();
}

export function updateDemoAction(actionId: string, decision: "approve" | "reject", reason?: string): ProoflineAction | undefined {
  const state = demoState();
  const action = state.actions.find((item) => item.action_id === actionId);
  if (!action || action.state !== "PENDING_APPROVAL") return action;
  action.state = decision === "approve" ? "READY" : "REJECTED";
  action.updated_at = new Date().toISOString();
  action.approved_by = decision === "approve" ? "alex@northstar.local" : null;
  action.rejection_reason = decision === "reject" ? reason || "Rejected by operator" : null;
  return structuredClone(action);
}
