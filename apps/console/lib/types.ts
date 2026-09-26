export type Point = { x: number; y: number };

export type WarehouseZone = {
  id: string;
  name: string;
  type: "storage" | "receiving" | "packing" | "shipping" | "charging";
  x: number;
  y: number;
  width: number;
  depth: number;
  color: string;
  inventoryUnits: number;
};

export type WarehouseRobot = {
  id: string;
  name: string;
  x: number;
  y: number;
  heading: number;
  battery: number;
  state: "idle" | "moving" | "picking" | "charging" | "paused" | "blocked";
  currentMissionId?: string;
  target?: string;
};

export type WarehouseMission = {
  id: string;
  orderRef: string;
  robotId: string;
  status: "queued" | "active" | "complete" | "paused";
  stage: string;
  progress: number;
  route: Point[];
};

export type WarehouseAnomaly = {
  id: string;
  severity: "low" | "medium" | "high";
  type: string;
  message: string;
  robotId?: string;
  createdAt: string;
};

export type WarehouseSnapshot = {
  warehouse: {
    id: string;
    name: string;
    width: number;
    depth: number;
    running: boolean;
    mode: string;
    lastUpdated: string;
  };
  zones: WarehouseZone[];
  robots: WarehouseRobot[];
  missions: WarehouseMission[];
  anomalies: WarehouseAnomaly[];
  kpis: {
    robotsOnline: number;
    activeMissions: number;
    ordersToday: number;
    avgPickMinutes: number;
  };
  activity: Array<{ id: string; message: string; createdAt: string; kind: string }>;
  source?: "warehouse-engine" | "console-demo";
};

export type ProoflineAction = {
  action_id: string;
  action_type: string;
  target_ref: string;
  state: string;
  request: Record<string, unknown>;
  approved_by?: string | null;
  rejection_reason?: string | null;
  created_at: string;
  updated_at: string;
};

export type IncidentSeverity = "SEV1" | "SEV2" | "SEV3" | "SEV4";

export type IncidentStatus =
  | "OPEN"
  | "ACKNOWLEDGED"
  | "INVESTIGATING"
  | "AWAITING_APPROVAL"
  | "REMEDIATING"
  | "ESCALATED"
  | "RESOLVED";

export type IncidentEvidenceKind =
  | "signal"
  | "metric"
  | "log"
  | "agent"
  | "operator"
  | "action";

export type IncidentEvidence = {
  id: string;
  kind: IncidentEvidenceKind;
  title: string;
  detail: string;
  source: string;
  createdAt: string;
  confidence?: number;
};

export type RunbookStepStatus = "pending" | "active" | "complete" | "blocked";

export type IncidentRunbookStep = {
  id: string;
  title: string;
  description: string;
  status: RunbookStepStatus;
  requiresApproval?: boolean;
  evidenceIds?: string[];
};

export type IncidentRemediation = {
  id: string;
  summary: string;
  action: string;
  scope: string;
  rollback: string;
  risk: "LOW" | "MEDIUM" | "HIGH";
  status: "PROPOSED" | "APPROVED" | "EXECUTING" | "EXECUTED" | "REJECTED" | "NOT_APPLIED" | "UNKNOWN";
  proposedBy: string;
  proposedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  verification?: {
    state: "APPLIED" | "NOT_APPLIED" | "UNKNOWN";
    detail: string;
    attributableProof?: string;
    verifiedAt?: string;
  };
};

export type IncidentEscalation = {
  id: string;
  target: string;
  reason: string;
  actor: string;
  createdAt: string;
};

export type OnCallIncident = {
  id: string;
  title: string;
  summary: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  service: string;
  source: string;
  owner?: string;
  commander?: string;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  slaMinutes: number;
  labels: string[];
  impact: {
    headline: string;
    ordersAtRisk: number;
    robotsAffected: number;
    zonesAffected: string[];
  };
  evidence: IncidentEvidence[];
  runbook: {
    name: string;
    version: string;
    steps: IncidentRunbookStep[];
  };
  remediation?: IncidentRemediation;
  escalations: IncidentEscalation[];
  similarIncidents?: Array<{
    incidentId: string;
    similarity: number;
    remediationAction: string;
    verified: boolean;
  }>;
  suggestedPlaybook?: {
    id: string;
    name: string;
    confidence: number;
    sourceEpisodes: string[];
    steps: string[];
  };
  timeline?: Array<{
    id: string;
    type: string;
    actor: string;
    message: string;
    createdAt: string;
  }>;
};

export type OnCallSummary = {
  total: number;
  active: number;
  critical: number;
  unowned: number;
  awaitingApproval: number;
  resolved: number;
  meanAcknowledgeMinutes: number;
};

export type OnCallActionName =
  | "acknowledge"
  | "investigate"
  | "propose-remediation"
  | "approve-remediation"
  | "escalate"
  | "resolve";
