from __future__ import annotations

import copy
import hashlib
import json
import os
import threading
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, Literal

import psycopg
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field


app = FastAPI(title="RelayGrid Impact & Digital Twin Engine", version="0.3.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

WAREHOUSE_ID = "WH-BLR-01"
GRID_WIDTH = 60
GRID_DEPTH = 40


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def route_between(start: dict[str, int], target: dict[str, int]) -> list[dict[str, int]]:
    """Create a deterministic rectilinear path on the 60x40 floor grid."""
    points = [{"x": start["x"], "y": start["y"]}]
    if start["x"] != target["x"]:
        points.append({"x": target["x"], "y": start["y"]})
    if start["y"] != target["y"]:
        points.append({"x": target["x"], "y": target["y"]})
    return points


def position_on_route(route: list[dict[str, int]], progress: int) -> dict[str, int]:
    if len(route) < 2:
        return route[0] if route else {"x": 0, "y": 0}
    scaled = min(100, max(0, progress)) / 100 * (len(route) - 1)
    segment = min(len(route) - 2, int(scaled))
    fraction = scaled - segment
    start, end = route[segment], route[segment + 1]
    return {
        "x": round(start["x"] + (end["x"] - start["x"]) * fraction),
        "y": round(start["y"] + (end["y"] - start["y"]) * fraction),
    }


class ImpactRequest(BaseModel):
    recallId: Annotated[str, Field(min_length=1, max_length=120)]
    lotIds: Annotated[list[str], Field(min_length=1, max_length=100)]


class TickRequest(BaseModel):
    steps: Annotated[int, Field(ge=1, le=25)] = 1


class ToggleRequest(BaseModel):
    running: bool | None = None


class DemoOrderRequest(BaseModel):
    sku: Annotated[str, Field(min_length=1, max_length=80)] = "RADIO-82"
    quantity: Annotated[int, Field(ge=1, le=25)] = 1
    priority: Annotated[int, Field(ge=1, le=5)] = 3
    destinationZoneId: str | None = None


class AnomalyRequest(BaseModel):
    robotId: str | None = None
    severity: Literal["info", "warning", "critical"] = "warning"
    type: Annotated[str, Field(min_length=1, max_length=80)] = "blocked_path"
    message: Annotated[str | None, Field(max_length=300)] = None


class RobotActionRequest(BaseModel):
    action: Literal["pause", "resume", "dispatch", "charge", "clear_anomaly"]
    targetZoneId: str | None = None


class IncidentDetectRequest(BaseModel):
    anomalyId: str | None = None


class IncidentAcknowledgeRequest(BaseModel):
    actor: Annotated[str, Field(min_length=2, max_length=120)]
    note: Annotated[str | None, Field(max_length=500)] = None


class IncidentInvestigateRequest(BaseModel):
    actor: Annotated[str, Field(min_length=2, max_length=120)]
    note: Annotated[str | None, Field(max_length=500)] = None


class IncidentEscalateRequest(BaseModel):
    actor: Annotated[str, Field(min_length=2, max_length=120)]
    reason: Annotated[str, Field(min_length=5, max_length=1000)]
    target: Annotated[str, Field(min_length=2, max_length=120)] = "warehouse-incident-commander"


class IncidentTimelineRequest(BaseModel):
    actor: Annotated[str, Field(min_length=2, max_length=120)]
    note: Annotated[str, Field(min_length=2, max_length=1000)]
    eventType: Annotated[str, Field(min_length=2, max_length=80)] = "operator_note"


class IncidentResolveRequest(BaseModel):
    actor: Annotated[str, Field(min_length=2, max_length=120)]
    resolutionNote: Annotated[str, Field(min_length=5, max_length=1000)]


RemediationAction = Literal["pause_robot", "send_to_charging", "clear_robot_anomaly", "reroute_robot"]


class PrepareRemediationRequest(BaseModel):
    action: RemediationAction
    targetRobotId: str | None = None
    targetZoneId: str | None = None
    rationale: Annotated[str, Field(min_length=5, max_length=1000)]
    scope: Annotated[str | None, Field(max_length=1000)] = None
    rollback: Annotated[str | None, Field(max_length=1000)] = None
    risk: Literal["LOW", "MEDIUM", "HIGH"] | None = None
    actionIntentId: Annotated[str | None, Field(max_length=160)] = None
    integrityMode: Literal["proofline", "demo-memory"] = "demo-memory"


class ExecuteRemediationRequest(BaseModel):
    approvedBy: Annotated[str, Field(min_length=2, max_length=160)]
    approvalNote: Annotated[str | None, Field(max_length=1000)] = None


def _new_demo_state() -> dict[str, Any]:
    clock = datetime.now(timezone.utc)
    now = clock.isoformat()
    return {
        "warehouse": {
            "id": WAREHOUSE_ID,
            "name": "RelayGrid Bengaluru Fulfilment Lab",
            "width": GRID_WIDTH,
            "depth": GRID_DEPTH,
            "running": True,
            "mode": "demo",
            "lastUpdated": now,
        },
        "tick": 0,
        "ordersToday": 148,
        "zones": [
            {"id": "ZONE-RECEIVING", "name": "Receiving", "type": "receiving", "x": 2, "y": 2, "width": 8, "depth": 27, "color": "#DCEBE5", "inventoryUnits": 196},
            {"id": "ZONE-RADIO", "name": "Radio Systems", "type": "storage", "x": 12, "y": 2, "width": 12, "depth": 9, "color": "#DCE8F2", "inventoryUnits": 420},
            {"id": "ZONE-SECURITY", "name": "Security Systems", "type": "storage", "x": 12, "y": 13, "width": 12, "depth": 8, "color": "#E7E0F2", "inventoryUnits": 184},
            {"id": "ZONE-PHOTO", "name": "Photo & Audio", "type": "storage", "x": 12, "y": 23, "width": 12, "depth": 8, "color": "#F1E4D8", "inventoryUnits": 86},
            {"id": "ZONE-SMART", "name": "Smart Home", "type": "storage", "x": 27, "y": 2, "width": 13, "depth": 12, "color": "#E2EDDB", "inventoryUnits": 312},
            {"id": "ZONE-GARDEN", "name": "Home & Garden", "type": "storage", "x": 27, "y": 16, "width": 13, "depth": 15, "color": "#E9E4D2", "inventoryUnits": 277},
            {"id": "ZONE-ELECTRICAL", "name": "Electrical", "type": "storage", "x": 43, "y": 2, "width": 11, "depth": 13, "color": "#EEE0DA", "inventoryUnits": 238},
            {"id": "ZONE-WELLNESS", "name": "Health & Wellness", "type": "storage", "x": 43, "y": 17, "width": 11, "depth": 14, "color": "#DCE9E9", "inventoryUnits": 165},
            {"id": "ZONE-PACKING", "name": "Packing", "type": "packing", "x": 11, "y": 34, "width": 20, "depth": 4, "color": "#E6E1F0", "inventoryUnits": 32},
            {"id": "ZONE-CHARGING", "name": "Charging", "type": "charging", "x": 45, "y": 34, "width": 11, "depth": 4, "color": "#E2E7D6", "inventoryUnits": 0},
        ],
        "robots": [
            {"id": "AGV-ATLAS", "name": "Atlas", "x": 14, "y": 6, "heading": 90, "battery": 87, "state": "executing", "currentMissionId": "MIS-1042"},
            {"id": "AGV-MILO", "name": "Milo", "x": 33, "y": 28, "heading": 180, "battery": 64, "state": "executing", "currentMissionId": "MIS-1043"},
            {"id": "AGV-NOVA", "name": "Nova", "x": 37, "y": 26, "heading": 270, "battery": 93, "state": "ready", "currentMissionId": None},
            {"id": "AGV-KITE", "name": "Kite", "x": 51, "y": 35, "heading": 0, "battery": 38, "state": "charging", "currentMissionId": None},
        ],
        "missions": [
            {"id": "MIS-1042", "orderRef": "ORD-62041", "robotId": "AGV-ATLAS", "status": "active", "stage": "picking", "progress": 42, "route": [{"x": 7, "y": 7}, {"x": 10, "y": 7}, {"x": 10, "y": 6}, {"x": 18, "y": 6}, {"x": 18, "y": 18}, {"x": 18, "y": 33}, {"x": 21, "y": 35}], "priority": 2},
            {"id": "MIS-1043", "orderRef": "ORD-62102", "robotId": "AGV-MILO", "status": "active", "stage": "transporting", "progress": 68, "route": [{"x": 20, "y": 18}, {"x": 25, "y": 18}, {"x": 25, "y": 25}, {"x": 33, "y": 25}, {"x": 33, "y": 33}, {"x": 24, "y": 35}], "priority": 3},
            {"id": "MIS-1039", "orderRef": "ORD-62077", "robotId": "AGV-NOVA", "status": "completed", "stage": "complete", "progress": 100, "route": [{"x": 46, "y": 21}, {"x": 41, "y": 21}, {"x": 41, "y": 33}, {"x": 27, "y": 35}], "priority": 3},
        ],
        "lots": [
            {"lotId": "LOT-0001", "sku": "RADIO-82", "productName": "Relay Radio Module", "quantity": 420, "status": "available", "zoneId": "ZONE-RADIO"},
            {"lotId": "LOT-0002", "sku": "CAM-14", "productName": "Compact Camera Board", "quantity": 86, "status": "available", "zoneId": "ZONE-PHOTO"},
        ],
        "incidentSequence": 3,
        "remediationReceipts": [],
        "incidentMemory": [
            {
                "incidentId": "INC-HIST-0004", "fingerprint": "battery_forecast:agv",
                "title": "Nova reserve battery dropped below dispatch threshold", "resolution": "sent robot to charging",
                "remediationAction": "send_to_charging", "durationMinutes": 9,
                "resolvedAt": (clock - timedelta(days=31)).isoformat(), "verified": True,
                "evidenceSummary": "Dedicated charge mission was attributed to the approved intent and completed without a duplicate dispatch.",
            },
            {
                "incidentId": "INC-HIST-0001", "fingerprint": "battery_forecast:agv",
                "title": "Milo battery drain during peak wave", "resolution": "sent robot to charging",
                "remediationAction": "send_to_charging", "durationMinutes": 11,
                "resolvedAt": (clock - timedelta(days=19)).isoformat(), "verified": True,
                "evidenceSummary": "Battery recovered from 17% to 84%; paused mission was reassigned.",
            },
            {
                "incidentId": "INC-HIST-0002", "fingerprint": "battery_forecast:agv",
                "title": "Atlas projected battery exhaustion", "resolution": "paused robot and sent it to charging",
                "remediationAction": "send_to_charging", "durationMinutes": 8,
                "resolvedAt": (clock - timedelta(days=7)).isoformat(), "verified": True,
                "evidenceSummary": "Attributable charge mission completed; no duplicate dispatch occurred.",
            },
            {
                "incidentId": "INC-HIST-0003", "fingerprint": "blocked_path:agv",
                "title": "Nova blocked in Electrical aisle", "resolution": "paused robot, cleared aisle, resumed mission",
                "remediationAction": "pause_robot", "durationMinutes": 14,
                "resolvedAt": (clock - timedelta(days=3)).isoformat(), "verified": True,
                "evidenceSummary": "Mission paused before intervention and continued from the same checkpoint.",
            },
        ],
        "incidents": [
            {
                "id": "INC-DEMO-0003",
                "title": "Kite battery recovery window at risk",
                "summary": "Kite entered charging after a low-battery forecast; fleet reserve capacity is reduced while two fulfilment missions remain active.",
                "severity": "SEV2", "status": "OPEN", "service": "warehouse-fleet",
                "source": "digital-twin", "owner": None,
                "createdAt": now, "updatedAt": now, "acknowledgedAt": None, "resolvedAt": None,
                "slaMinutes": 8,
                "labels": ["battery_forecast", "robot:AGV-KITE", "warehouse:WH-BLR-01"],
                "anomalyId": "ANOM-0001", "robotId": "AGV-KITE", "missionId": None, "orderRef": None,
                "fingerprint": "battery_forecast:agv",
                "impact": {
                    "headline": "One of four robots is unavailable; two orders are actively moving.",
                    "ordersAtRisk": 2, "robotsAffected": 1, "zonesAffected": ["ZONE-CHARGING"],
                },
                "evidence": [
                    {"id": "EVD-INC-DEMO-0003-1", "kind": "anomaly", "title": "Battery forecast warning",
                     "detail": "Kite is charging after a low-battery forecast.", "source": "digital-twin/anomalies",
                     "createdAt": now, "confidence": 0.99},
                    {"id": "EVD-INC-DEMO-0003-2", "kind": "fleet_snapshot", "title": "Reduced reserve capacity",
                     "detail": "Kite battery 38%; Atlas and Milo have active missions; Nova is the only ready robot.",
                     "source": "digital-twin/robots", "createdAt": now, "confidence": 1.0},
                ],
                "runbook": {
                    "name": "Fleet incident containment", "version": 1,
                    "steps": [
                        {"id": "detect", "title": "Detect and correlate", "description": "Link the anomaly to its robot, mission and order.", "status": "DONE", "requiresApproval": False},
                        {"id": "ack", "title": "Acknowledge", "description": "Assign an incident owner before the acknowledgement SLO expires.", "status": "PENDING", "requiresApproval": False},
                        {"id": "investigate", "title": "Investigate", "description": "Read live evidence and recall verified similar incidents.", "status": "PENDING", "requiresApproval": False},
                        {"id": "prepare", "title": "Prepare remediation", "description": "Create an idempotent Proofline action intent.", "status": "PENDING", "requiresApproval": False},
                        {"id": "execute", "title": "Approve and execute", "description": "A human approves the exact scoped MCP action before execution.", "status": "PENDING", "requiresApproval": True},
                        {"id": "verify", "title": "Verify and learn", "description": "Verify attributable evidence, resolve, and retain the outcome.", "status": "PENDING", "requiresApproval": False},
                    ],
                },
                "similarIncidents": [
                    {"incidentId": "INC-HIST-0002", "similarity": 0.94, "remediationAction": "send_to_charging", "verified": True},
                    {"incidentId": "INC-HIST-0001", "similarity": 0.87, "remediationAction": "send_to_charging", "verified": True},
                    {"incidentId": "INC-HIST-0004", "similarity": 0.82, "remediationAction": "send_to_charging", "verified": True},
                ],
                "suggestedPlaybook": {
                    "id": "PB-BATTERY-RECOVERY", "name": "AGV battery recovery", "confidence": 0.91,
                    "status": "CONSOLIDATED",
                    "sourceEpisodes": ["INC-HIST-0004", "INC-HIST-0001", "INC-HIST-0002"],
                    "steps": ["Confirm battery telemetry", "Pause or reassign the active mission", "Send the robot to charging", "Verify charge mission and fleet capacity"],
                },
                "timeline": [
                    {"id": "EVT-INC-DEMO-0003-1", "type": "incident_opened", "actor": "relaygrid-detector",
                     "message": "Incident opened from anomaly ANOM-0001.", "createdAt": now},
                    {"id": "EVT-INC-DEMO-0003-2", "type": "memory_recalled", "actor": "relaygrid-oncall",
                     "message": "Recalled 3 verified battery-recovery incidents; playbook is consolidated.", "createdAt": now},
                ],
                "remediation": None, "remediationIntents": [], "escalations": [],
                "meta": {"store": "demo-memory", "ackDeadlineAt": (clock + timedelta(minutes=8)).isoformat()},
            }
        ],
        "anomalies": [
            {"id": "ANOM-0001", "severity": "warning", "type": "battery_forecast", "message": "Kite is charging after a low-battery forecast.", "robotId": "AGV-KITE", "createdAt": now, "resolved": False},
        ],
        "activity": [
            {"id": "ACT-3", "type": "charge_started", "message": "Kite docked at charging bay 2.", "createdAt": now},
            {"id": "ACT-2", "type": "order_received", "message": "Order ORD-62102 entered the fulfilment queue.", "createdAt": now},
            {"id": "ACT-1", "type": "mission_started", "message": "Atlas started pick mission MIS-1042.", "createdAt": now},
        ],
    }


_state_lock = threading.RLock()
_demo_state = _new_demo_state()


def _activity(state: dict[str, Any], activity_type: str, message: str) -> None:
    state["activity"].insert(0, {
        "id": f"ACT-{state['tick']}-{len(state['activity']) + 1}",
        "type": activity_type,
        "message": message,
        "createdAt": utc_now(),
    })
    del state["activity"][20:]


def _incident_event(incident: dict[str, Any], event_type: str, actor: str, message: str) -> None:
    now = utc_now()
    incident["timeline"].append({
        "id": f"EVT-{incident['id']}-{len(incident['timeline']) + 1}",
        "type": event_type,
        "actor": actor,
        "message": message,
        "createdAt": now,
    })
    incident["updatedAt"] = now


def _set_runbook_step(incident: dict[str, Any], step_id: str, status: str) -> None:
    for step in incident["runbook"]["steps"]:
        if step["id"] == step_id:
            step["status"] = status


def _incident_or_404(incident_id: str) -> dict[str, Any]:
    incident = next((item for item in _demo_state["incidents"] if item["id"] == incident_id), None)
    if not incident:
        raise HTTPException(status_code=404, detail="incident not found")
    return incident


def _open_incident_for_anomaly_locked(anomaly: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    existing = next(
        (
            item for item in _demo_state["incidents"]
            if item.get("anomalyId") == anomaly.get("id") and item.get("status") != "RESOLVED"
        ),
        None,
    )
    if existing:
        return existing, False

    now = utc_now()
    robot = next((item for item in _demo_state["robots"] if item["id"] == anomaly.get("robotId")), None)
    mission = next(
        (item for item in _demo_state["missions"] if robot and item["id"] == robot.get("currentMissionId")),
        None,
    )
    _demo_state["incidentSequence"] += 1
    incident_id = f"INC-DEMO-{_demo_state['incidentSequence']:04d}"
    anomaly_type = str(anomaly.get("type") or "warehouse_anomaly")
    fingerprint = f"{anomaly_type}:{'agv' if robot else 'warehouse'}"
    severity = {"critical": "SEV1", "warning": "SEV2", "info": "SEV3"}.get(anomaly.get("severity"), "SEV3")
    similar_memory = [item for item in _demo_state["incidentMemory"] if item["fingerprint"] == fingerprint]
    similar = [
        {
            "incidentId": item["incidentId"],
            "similarity": round(max(0.72, 0.94 - index * 0.07), 2),
            "remediationAction": item["remediationAction"],
            "verified": item["verified"],
        }
        for index, item in enumerate(reversed(similar_memory[-3:]))
    ]
    robot_name = robot["name"] if robot else "warehouse"
    mission_ref = mission["id"] if mission else None
    order_ref = mission["orderRef"] if mission else None
    zones = []
    if robot:
        zone = next(
            (
                item for item in _demo_state["zones"]
                if item["x"] <= robot["x"] <= item["x"] + item["width"]
                and item["y"] <= robot["y"] <= item["y"] + item["depth"]
            ),
            None,
        )
        if zone:
            zones.append(zone["id"])
    active_orders = 1 if mission and mission["status"] in ("active", "paused") else 0
    incident = {
        "id": incident_id,
        "title": f"{robot_name}: {anomaly_type.replace('_', ' ')}",
        "summary": anomaly.get("message") or f"{anomaly_type.replace('_', ' ').title()} detected in the warehouse.",
        "severity": severity, "status": "OPEN", "service": "warehouse-fleet",
        "source": "digital-twin", "owner": None,
        "createdAt": now, "updatedAt": now, "acknowledgedAt": None, "resolvedAt": None,
        "slaMinutes": 4 if severity == "SEV1" else 8 if severity == "SEV2" else 15,
        "labels": [anomaly_type, f"warehouse:{WAREHOUSE_ID}"] + ([f"robot:{robot['id']}"] if robot else []),
        "anomalyId": anomaly.get("id"), "robotId": robot["id"] if robot else None,
        "missionId": mission_ref, "orderRef": order_ref, "fingerprint": fingerprint,
        "impact": {
            "headline": f"{robot_name} is unavailable" + (f" while {order_ref} is in flight." if order_ref else "."),
            "ordersAtRisk": active_orders, "robotsAffected": 1 if robot else 0, "zonesAffected": zones,
        },
        "evidence": [
            {"id": f"EVD-{incident_id}-1", "kind": "anomaly", "title": "Correlated warehouse anomaly",
             "detail": anomaly.get("message") or anomaly_type, "source": "digital-twin/anomalies",
             "createdAt": anomaly.get("createdAt", now), "confidence": 0.99},
            {"id": f"EVD-{incident_id}-2", "kind": "robot_state", "title": "Robot and mission correlation",
             "detail": (f"{robot_name} state={robot['state']}, battery={robot['battery']}%, mission={mission_ref or 'none'}, order={order_ref or 'none'}."
                        if robot else "No robot was associated with this warehouse anomaly."),
             "source": "digital-twin/robots", "createdAt": now, "confidence": 1.0},
        ],
        "runbook": {
            "name": "Fleet incident containment", "version": 1,
            "steps": [
                {"id": "detect", "title": "Detect and correlate", "description": "Link the anomaly to its robot, mission and order.", "status": "DONE", "requiresApproval": False},
                {"id": "ack", "title": "Acknowledge", "description": "Assign an incident owner before the acknowledgement SLO expires.", "status": "PENDING", "requiresApproval": False},
                {"id": "investigate", "title": "Investigate", "description": "Read live evidence and recall verified similar incidents.", "status": "PENDING", "requiresApproval": False},
                {"id": "prepare", "title": "Prepare remediation", "description": "Create an idempotent Proofline action intent.", "status": "PENDING", "requiresApproval": False},
                {"id": "execute", "title": "Approve and execute", "description": "A human approves the exact scoped MCP action before execution.", "status": "PENDING", "requiresApproval": True},
                {"id": "verify", "title": "Verify and learn", "description": "Verify attributable evidence, resolve, and retain the outcome.", "status": "PENDING", "requiresApproval": False},
            ],
        },
        "similarIncidents": similar,
        "suggestedPlaybook": {
            "id": f"PB-{anomaly_type.upper()}",
            "name": f"{anomaly_type.replace('_', ' ').title()} recovery",
            "status": "CONSOLIDATED" if len(similar) >= 3 else "CANDIDATE",
            "confidence": round(sum(item["similarity"] for item in similar) / len(similar), 2) if similar else 0.55,
            "sourceEpisodes": [item["incidentId"] for item in similar],
            "steps": ["Confirm current telemetry", "Contain the affected robot or mission", "Request approval for the scoped action", "Verify attributable outcome"],
        },
        "timeline": [
            {"id": f"EVT-{incident_id}-1", "type": "incident_opened", "actor": "relaygrid-detector",
             "message": f"Incident opened from anomaly {anomaly.get('id')}.", "createdAt": now},
            {"id": f"EVT-{incident_id}-2", "type": "memory_recalled", "actor": "relaygrid-oncall",
             "message": f"Recalled {len(similar)} verified incidents with fingerprint {fingerprint}.", "createdAt": now},
        ],
        "remediation": None, "remediationIntents": [], "escalations": [],
        "meta": {
            "store": "demo-memory",
            "ackDeadlineAt": (datetime.now(timezone.utc) + timedelta(minutes=4 if severity == "SEV1" else 8 if severity == "SEV2" else 15)).isoformat(),
        },
    }
    _demo_state["incidents"].insert(0, incident)
    _activity(_demo_state, "incident_opened", f"{incident_id} opened for {incident['title']}.")
    _persist_incident(incident, required=False)
    return incident, True


def _internal_action_allowed(supplied: str | None) -> bool:
    expected = os.getenv("IMPACT_ENGINE_INTERNAL_TOKEN", "").strip()
    if expected:
        return supplied == expected
    return os.getenv("ALLOW_INSECURE_LOCAL_DEMO", "").lower() == "true"


def _ensure_oncall_tables(connection: Any) -> None:
    connection.execute("""
        CREATE TABLE IF NOT EXISTS inventory.oncall_incidents (
            incident_id text PRIMARY KEY,
            anomaly_id text,
            fingerprint text NOT NULL,
            status text NOT NULL,
            snapshot jsonb NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
        )
    """)
    connection.execute("""
        CREATE TABLE IF NOT EXISTS inventory.remediation_receipts (
            action_intent_id text PRIMARY KEY,
            receipt_id text NOT NULL UNIQUE,
            incident_id text NOT NULL,
            site_id text NOT NULL REFERENCES inventory.warehouse_sites(site_id) ON DELETE CASCADE,
            action_type text NOT NULL,
            target_robot_id text NOT NULL REFERENCES inventory.agv_robots(robot_id),
            target_zone_id text REFERENCES inventory.warehouse_zones(zone_id),
            evidence jsonb NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT now()
        )
    """)


def _persist_incident(incident: dict[str, Any], *, required: bool = False) -> bool:
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        return False
    try:
        with psycopg.connect(dsn, connect_timeout=2) as connection:
            _ensure_oncall_tables(connection)
            connection.execute(
                """INSERT INTO inventory.oncall_incidents
                       (incident_id, anomaly_id, fingerprint, status, snapshot, created_at, updated_at)
                     VALUES (%s, %s, %s, %s, %s, %s, now())
                     ON CONFLICT (incident_id) DO UPDATE SET
                       anomaly_id = EXCLUDED.anomaly_id,
                       fingerprint = EXCLUDED.fingerprint,
                       status = EXCLUDED.status,
                       snapshot = EXCLUDED.snapshot,
                       updated_at = now()""",
                (
                    incident["id"], incident.get("anomalyId"), incident["fingerprint"], incident["status"],
                    Jsonb(copy.deepcopy(incident)), datetime.fromisoformat(incident["createdAt"]),
                ),
            )
        incident.setdefault("meta", {})["persistence"] = "postgres"
        return True
    except (psycopg.Error, RuntimeError, KeyError, ValueError) as error:
        incident.setdefault("meta", {})["persistence"] = "demo-memory"
        if required:
            raise RuntimeError(f"incident persistence failed: {error}") from error
        return False


def _hydrate_oncall_state() -> None:
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        return
    try:
        with psycopg.connect(dsn, connect_timeout=2, row_factory=dict_row) as connection:
            _ensure_oncall_tables(connection)
            rows = connection.execute(
                "SELECT snapshot FROM inventory.oncall_incidents ORDER BY updated_at DESC"
            ).fetchall()
    except (psycopg.Error, RuntimeError):
        return
    if not rows:
        return
    with _state_lock:
        merged = {item["id"]: item for item in _demo_state["incidents"]}
        for row in rows:
            snapshot = row["snapshot"]
            if isinstance(snapshot, dict) and snapshot.get("id"):
                merged[snapshot["id"]] = snapshot
        _demo_state["incidents"] = sorted(
            merged.values(), key=lambda item: item.get("updatedAt", item.get("createdAt", "")), reverse=True
        )
        numeric_ids = [
            int(item["id"].rsplit("-", 1)[-1])
            for item in _demo_state["incidents"]
            if item["id"].startswith("INC-DEMO-") and item["id"].rsplit("-", 1)[-1].isdigit()
        ]
        if numeric_ids:
            _demo_state["incidentSequence"] = max(_demo_state["incidentSequence"], max(numeric_ids))


_hydrate_oncall_state()


def _serialize_state(state: dict[str, Any], source: str) -> dict[str, Any]:
    warehouse = copy.deepcopy(state["warehouse"])
    warehouse["lastUpdated"] = utc_now()
    robots = copy.deepcopy(state["robots"])
    missions = copy.deepcopy(state["missions"])
    mission_by_id = {mission["id"]: mission for mission in missions}
    for robot in robots:
        mission = mission_by_id.get(robot.get("currentMissionId"))
        route = mission.get("route", []) if mission else []
        robot["target"] = copy.deepcopy(route[-1]) if route else None
    lots = copy.deepcopy(state["lots"])
    open_anomalies = [copy.deepcopy(item) for item in state["anomalies"] if not item.get("resolved")]
    for item in open_anomalies:
        item.pop("resolved", None)
    active_missions = sum(1 for mission in missions if mission["status"] == "active")
    online = sum(1 for robot in robots if robot["state"] != "offline")
    total_units = sum(lot["quantity"] for lot in lots)
    available_units = sum(lot["quantity"] for lot in lots if lot["status"] == "available")
    quarantined_units = sum(lot["quantity"] for lot in lots if lot["status"] == "quarantined")
    incidents = copy.deepcopy(state.get("incidents", []))
    open_incidents = [incident for incident in incidents if incident["status"] != "RESOLVED"]
    needs_attention = [
        incident for incident in open_incidents
        if incident["status"] in ("OPEN", "AWAITING_APPROVAL", "ESCALATED")
    ]
    return {
        "warehouse": warehouse,
        "zones": copy.deepcopy(state["zones"]),
        "robots": robots,
        "missions": missions,
        "anomalies": open_anomalies,
        "kpis": {
            "robotsOnline": online,
            "activeMissions": active_missions,
            "ordersToday": state["ordersToday"],
            "avgPickMinutes": round(6.4 + active_missions * 0.25, 1),
        },
        "inventory": {
            "totalUnits": total_units,
            "availableUnits": available_units,
            "quarantinedUnits": quarantined_units,
            "lowStockLots": sum(1 for lot in lots if lot["quantity"] < 100),
            "lots": lots,
        },
        "activity": copy.deepcopy(state["activity"]),
        "onCall": {
            "duty": {"team": "Warehouse Reliability", "primary": "RelayGrid Operator", "shift": "demo-local"},
            "open": len(open_incidents),
            "needsAttention": len(needs_attention),
            "severityCounts": {
                severity: sum(1 for incident in open_incidents if incident["severity"] == severity)
                for severity in ("SEV1", "SEV2", "SEV3", "SEV4")
            },
            "metrics": {
                "acknowledgementSloMinutes": 8,
                "verifiedMemoryEpisodes": len(state.get("incidentMemory", [])),
                "approvalPending": sum(1 for incident in open_incidents if incident["status"] == "AWAITING_APPROVAL"),
            },
            "recentIncidents": incidents[:5],
        },
        "meta": {
            "source": source,
            "simulationTick": state["tick"],
            "databaseConfigured": bool(os.getenv("DATABASE_URL")),
            "mutationStoreAvailable": source == "postgres" or not bool(os.getenv("DATABASE_URL")),
        },
    }


def _memory_snapshot() -> dict[str, Any]:
    with _state_lock:
        return _serialize_state(_demo_state, "demo-memory")


def _postgres_snapshot() -> dict[str, Any]:
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL is not configured")
    with psycopg.connect(dsn, connect_timeout=2, row_factory=dict_row) as connection:
        site = connection.execute("SELECT * FROM inventory.warehouse_sites WHERE site_id = %s", (WAREHOUSE_ID,)).fetchone()
        if not site:
            raise RuntimeError("warehouse demo state is not seeded")
        zone_rows = connection.execute("SELECT * FROM inventory.warehouse_zones WHERE site_id = %s ORDER BY zone_id", (WAREHOUSE_ID,)).fetchall()
        robot_rows = connection.execute("SELECT * FROM inventory.agv_robots WHERE site_id = %s ORDER BY robot_id", (WAREHOUSE_ID,)).fetchall()
        mission_rows = connection.execute("SELECT * FROM inventory.robot_missions WHERE site_id = %s ORDER BY created_at DESC", (WAREHOUSE_ID,)).fetchall()
        anomaly_rows = connection.execute("SELECT * FROM inventory.warehouse_anomalies WHERE site_id = %s AND resolved = false ORDER BY created_at DESC", (WAREHOUSE_ID,)).fetchall()
        lot_rows = connection.execute("SELECT lot_id, sku, product_name, quantity, status, zone_id FROM inventory.lots ORDER BY lot_id").fetchall()
        activity_rows = connection.execute(
            "SELECT activity_id, activity_type, message, created_at FROM inventory.warehouse_activity WHERE site_id = %s ORDER BY created_at DESC LIMIT 20",
            (WAREHOUSE_ID,),
        ).fetchall()

    missions = [
        {"id": row["mission_id"], "orderRef": row["order_ref"], "robotId": row["robot_id"],
         "status": row["status"], "stage": row["stage"], "progress": row["progress"],
         "route": row["route"], "priority": row["priority"]}
        for row in mission_rows
    ]
    mission_by_id = {mission["id"]: mission for mission in missions}
    robots = []
    for row in robot_rows:
        mission = mission_by_id.get(row["current_mission_id"])
        route = mission["route"] if mission else []
        robots.append({
            "id": row["robot_id"], "name": row["name"], "x": row["x"], "y": row["y"],
            "heading": row["heading"], "battery": row["battery"], "state": row["state"],
            "currentMissionId": row["current_mission_id"], "target": route[-1] if route else None,
        })
    lots = [
        {"lotId": row["lot_id"], "sku": row["sku"], "productName": row["product_name"],
         "quantity": row["quantity"], "status": row["status"], "zoneId": row["zone_id"]}
        for row in lot_rows
    ]
    active_missions = sum(1 for mission in missions if mission["status"] == "active")
    return {
        "warehouse": {
            "id": site["site_id"], "name": site["name"], "width": site["width"], "depth": site["depth"],
            "running": site["running"], "mode": site["mode"], "lastUpdated": site["updated_at"].isoformat(),
        },
        "zones": [
            {"id": row["zone_id"], "name": row["name"], "type": row["zone_type"], "x": row["x"], "y": row["y"],
             "width": row["width"], "depth": row["depth"], "color": row["color"], "inventoryUnits": row["inventory_units"]}
            for row in zone_rows
        ],
        "robots": robots,
        "missions": missions,
        "anomalies": [
            {"id": row["anomaly_id"], "severity": row["severity"], "type": row["anomaly_type"],
             "message": row["message"], "robotId": row["robot_id"], "createdAt": row["created_at"].isoformat()}
            for row in anomaly_rows
        ],
        "kpis": {
            "robotsOnline": sum(1 for robot in robots if robot["state"] != "offline"),
            "activeMissions": active_missions,
            "ordersToday": site["orders_today"],
            "avgPickMinutes": round(6.4 + active_missions * 0.25, 1),
        },
        "inventory": {
            "totalUnits": sum(lot["quantity"] for lot in lots),
            "availableUnits": sum(lot["quantity"] for lot in lots if lot["status"] == "available"),
            "quarantinedUnits": sum(lot["quantity"] for lot in lots if lot["status"] == "quarantined"),
            "lowStockLots": sum(1 for lot in lots if lot["quantity"] < 100),
            "lots": lots,
        },
        "activity": [
            {"id": f"ACT-{row['activity_id']}", "type": row["activity_type"], "message": row["message"],
             "createdAt": row["created_at"].isoformat()}
            for row in activity_rows
        ],
        "meta": {
            "source": "postgres", "simulationTick": site["simulation_tick"],
            "databaseConfigured": True, "mutationStoreAvailable": True,
        },
    }


def warehouse_snapshot() -> dict[str, Any]:
    try:
        return _postgres_snapshot()
    except (psycopg.Error, RuntimeError):
        return _memory_snapshot()


def _authoritative_mutation_store() -> Literal["postgres", "demo-memory"]:
    """Select a write store without silently degrading a configured database."""
    if os.getenv("DATABASE_URL"):
        try:
            _postgres_snapshot()
        except (psycopg.Error, RuntimeError, KeyError) as error:
            raise HTTPException(
                status_code=503,
                detail=f"configured PostgreSQL mutation store is unavailable: {error}",
            ) from error
        return "postgres"
    return "demo-memory"


def _tick_memory(steps: int) -> dict[str, Any]:
    with _state_lock:
        for _ in range(steps):
            if not _demo_state["warehouse"]["running"]:
                break
            _demo_state["tick"] += 1
            for robot in _demo_state["robots"]:
                if robot["state"] == "charging":
                    robot["battery"] = min(100, robot["battery"] + 4)
                    if robot["battery"] == 100:
                        robot["state"] = "ready"
                        _activity(_demo_state, "charge_complete", f"{robot['name']} reached full charge.")
                    continue
                if robot["state"] != "executing" or not robot.get("currentMissionId"):
                    continue
                mission = next((item for item in _demo_state["missions"] if item["id"] == robot["currentMissionId"]), None)
                if not mission or mission["status"] != "active":
                    continue
                mission["progress"] = min(100, mission["progress"] + 2)
                route = mission["route"]
                previous_x, previous_y = robot["x"], robot["y"]
                point = position_on_route(route, mission["progress"])
                robot["x"], robot["y"] = point["x"], point["y"]
                if robot["x"] > previous_x:
                    robot["heading"] = 90
                elif robot["x"] < previous_x:
                    robot["heading"] = 270
                elif robot["y"] > previous_y:
                    robot["heading"] = 180
                elif robot["y"] < previous_y:
                    robot["heading"] = 0
                robot["battery"] = max(1, robot["battery"] - 1)
                if mission["progress"] == 100:
                    mission["status"] = "completed"
                    mission["stage"] = "complete"
                    robot["state"] = "charging" if mission["orderRef"] == "BATTERY-RECOVERY" else "ready"
                    robot["currentMissionId"] = None
                    _activity(_demo_state, "mission_complete", f"{robot['name']} completed {mission['id']} for {mission['orderRef']}.")
                elif mission["progress"] >= 75:
                    mission["stage"] = "packing"
                elif mission["progress"] >= 45:
                    mission["stage"] = "transporting"
            _demo_state["warehouse"]["lastUpdated"] = utc_now()
        return _serialize_state(_demo_state, "demo-memory")


def _tick_postgres(steps: int) -> dict[str, Any]:
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL is not configured")
    with psycopg.connect(dsn, connect_timeout=2, row_factory=dict_row) as connection:
        for _ in range(steps):
            site = connection.execute("SELECT running FROM inventory.warehouse_sites WHERE site_id = %s FOR UPDATE", (WAREHOUSE_ID,)).fetchone()
            if not site or not site["running"]:
                break
            connection.execute("UPDATE inventory.warehouse_sites SET simulation_tick = simulation_tick + 1, updated_at = now() WHERE site_id = %s", (WAREHOUSE_ID,))
            connection.execute("UPDATE inventory.agv_robots SET battery = LEAST(100, battery + 4), updated_at = now() WHERE site_id = %s AND state = 'charging'", (WAREHOUSE_ID,))
            charged = connection.execute("UPDATE inventory.agv_robots SET state = 'ready', current_mission_id = NULL, updated_at = now() WHERE site_id = %s AND state = 'charging' AND battery >= 100 RETURNING name", (WAREHOUSE_ID,)).fetchall()
            for robot in charged:
                connection.execute("INSERT INTO inventory.warehouse_activity(site_id, activity_type, message) VALUES (%s, 'charge_complete', %s)", (WAREHOUSE_ID, f"{robot['name']} reached full charge."))
            rows = connection.execute(
                """SELECT m.mission_id, m.order_ref, m.progress, m.route, r.robot_id, r.name, r.x, r.y
                   FROM inventory.robot_missions m JOIN inventory.agv_robots r ON r.robot_id = m.robot_id
                   WHERE m.site_id = %s AND m.status = 'active' AND r.state = 'executing' FOR UPDATE""",
                (WAREHOUSE_ID,),
            ).fetchall()
            for row in rows:
                progress = min(100, row["progress"] + 2)
                route = row["route"]
                point = position_on_route(route, progress)
                heading = 90 if point["x"] > row["x"] else 270 if point["x"] < row["x"] else 180 if point["y"] > row["y"] else 0
                complete = progress == 100
                stage = "complete" if complete else "packing" if progress >= 75 else "transporting" if progress >= 45 else "picking"
                connection.execute("UPDATE inventory.robot_missions SET progress = %s, stage = %s, status = %s, updated_at = now() WHERE mission_id = %s", (progress, stage, "completed" if complete else "active", row["mission_id"]))
                next_state = "charging" if complete and row["order_ref"] == "BATTERY-RECOVERY" else "ready" if complete else "executing"
                connection.execute(
                    "UPDATE inventory.agv_robots SET x = %s, y = %s, heading = %s, battery = GREATEST(1, battery - 1), state = %s, current_mission_id = %s, updated_at = now() WHERE robot_id = %s",
                    (point["x"], point["y"], heading, next_state, None if complete else row["mission_id"], row["robot_id"]),
                )
                if complete:
                    connection.execute("INSERT INTO inventory.warehouse_activity(site_id, activity_type, message) VALUES (%s, 'mission_complete', %s)", (WAREHOUSE_ID, f"{row['name']} completed {row['mission_id']} for {row['order_ref']}."))
    return _postgres_snapshot()


def _toggle_memory(requested: bool | None) -> dict[str, Any]:
    with _state_lock:
        current = _demo_state["warehouse"]["running"]
        running = (not current) if requested is None else requested
        _demo_state["warehouse"]["running"] = running
        _demo_state["warehouse"]["mode"] = "demo" if running else "paused"
        _activity(_demo_state, "simulation_state", f"Digital twin {'resumed' if running else 'paused'} by operator.")
        return _serialize_state(_demo_state, "demo-memory")


def _create_order_memory(payload: DemoOrderRequest) -> dict[str, Any]:
    with _state_lock:
        _demo_state["ordersToday"] += 1
        order_ref = f"ORD-DEMO-{_demo_state['ordersToday']}"
        mission_id = f"MIS-DEMO-{_demo_state['ordersToday']}"
        destination = next((zone for zone in _demo_state["zones"] if zone["id"] == payload.destinationZoneId), None)
        if not destination:
            storage = [zone for zone in _demo_state["zones"] if zone["type"] == "storage"]
            destination = storage[_demo_state["ordersToday"] % len(storage)]
        robot = next((item for item in _demo_state["robots"] if item["state"] == "ready"), None)
        target = {"x": destination["x"] + destination["width"] // 2, "y": destination["y"] + destination["depth"] // 2}
        route = route_between({"x": robot["x"], "y": robot["y"]}, target) if robot else []
        mission = {
            "id": mission_id, "orderRef": order_ref, "robotId": robot["id"] if robot else None,
            "status": "active" if robot else "queued", "stage": "routing" if robot else "queued",
            "progress": 0, "route": route, "priority": payload.priority,
        }
        _demo_state["missions"].insert(0, mission)
        if robot:
            robot["state"] = "executing"
            robot["currentMissionId"] = mission_id
        assigned = robot["name"] if robot else "the queue"
        _activity(_demo_state, "order_received", f"{order_ref}: {payload.quantity} × {payload.sku} created; {assigned} assigned.")
        return _serialize_state(_demo_state, "demo-memory")


def _inject_anomaly_memory(payload: AnomalyRequest) -> dict[str, Any]:
    with _state_lock:
        robot = next((item for item in _demo_state["robots"] if item["id"] == payload.robotId), None)
        if not robot:
            candidates = [item for item in _demo_state["robots"] if item["state"] not in ("offline", "charging")]
            robot = candidates[_demo_state["tick"] % len(candidates)] if candidates else None
        anomaly_id = f"ANOM-DEMO-{_demo_state['tick']}-{len(_demo_state['anomalies']) + 1}"
        message = payload.message or (f"{robot['name']} reported a blocked aisle and paused safely." if robot else "A blocked aisle was detected.")
        anomaly = {
            "id": anomaly_id, "severity": payload.severity, "type": payload.type, "message": message,
            "robotId": robot["id"] if robot else None, "createdAt": utc_now(), "resolved": False,
        }
        _demo_state["anomalies"].insert(0, anomaly)
        if robot:
            robot["state"] = "blocked"
            mission = next((item for item in _demo_state["missions"] if item["id"] == robot.get("currentMissionId")), None)
            if mission and mission["status"] == "active":
                mission["status"] = "paused"
                mission["stage"] = "exception"
        _activity(_demo_state, "anomaly_detected", message)
        _open_incident_for_anomaly_locked(anomaly)
        return _serialize_state(_demo_state, "demo-memory")


def _robot_action_memory(robot_id: str, payload: RobotActionRequest) -> dict[str, Any]:
    with _state_lock:
        robot = next((item for item in _demo_state["robots"] if item["id"] == robot_id), None)
        if not robot:
            raise HTTPException(status_code=404, detail="robot not found")
        mission = next((item for item in _demo_state["missions"] if item["id"] == robot.get("currentMissionId")), None)
        if payload.action == "pause":
            robot["state"] = "paused"
            if mission and mission["status"] == "active":
                mission["status"] = "paused"
        elif payload.action == "resume":
            robot["state"] = "executing" if mission else "ready"
            if mission and mission["status"] == "paused":
                mission["status"] = "active"
                mission["stage"] = "transporting"
        elif payload.action == "clear_anomaly":
            for anomaly in _demo_state["anomalies"]:
                if anomaly.get("robotId") == robot_id:
                    anomaly["resolved"] = True
            robot["state"] = "executing" if mission else "ready"
            if mission and mission["status"] == "paused":
                mission["status"] = "active"
                mission["stage"] = "transporting"
        else:
            target_zone_id = "ZONE-CHARGING" if payload.action == "charge" else payload.targetZoneId
            zone = next((item for item in _demo_state["zones"] if item["id"] == target_zone_id), None)
            if not zone:
                raise HTTPException(status_code=422, detail="targetZoneId is required and must identify a warehouse zone")
            mission_id = f"MIS-{payload.action.upper()}-{robot_id}-{_demo_state['tick']}-{len(_demo_state['missions']) + 1}"
            target = {"x": zone["x"] + zone["width"] // 2, "y": zone["y"] + zone["depth"] // 2}
            new_mission = {
                "id": mission_id, "orderRef": "BATTERY-RECOVERY" if payload.action == "charge" else "OPERATOR-DISPATCH",
                "robotId": robot_id, "status": "active", "stage": "routing", "progress": 0,
                "route": route_between({"x": robot["x"], "y": robot["y"]}, target), "priority": 1,
            }
            if mission and mission["status"] in ("active", "paused"):
                mission["status"] = "cancelled"
                mission["stage"] = "superseded"
            _demo_state["missions"].insert(0, new_mission)
            robot["currentMissionId"] = mission_id
            robot["state"] = "executing"
        _activity(_demo_state, "robot_action", f"{payload.action.replace('_', ' ').title()} sent to {robot['name']}.")
        return _serialize_state(_demo_state, "demo-memory")


def _reset_memory() -> dict[str, Any]:
    global _demo_state
    with _state_lock:
        _demo_state = _new_demo_state()
        return _serialize_state(_demo_state, "demo-memory")


def _create_order_postgres(payload: DemoOrderRequest) -> dict[str, Any]:
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL is not configured")
    with psycopg.connect(dsn, connect_timeout=2, row_factory=dict_row) as connection:
        site = connection.execute(
            "SELECT orders_today FROM inventory.warehouse_sites WHERE site_id = %s FOR UPDATE", (WAREHOUSE_ID,)
        ).fetchone()
        if not site:
            raise RuntimeError("warehouse is not seeded")
        order_number = site["orders_today"] + 1
        order_ref = f"ORD-DEMO-{order_number}"
        mission_id = f"MIS-DEMO-{order_number}"
        if payload.destinationZoneId:
            destination = connection.execute(
                "SELECT * FROM inventory.warehouse_zones WHERE site_id = %s AND zone_id = %s",
                (WAREHOUSE_ID, payload.destinationZoneId),
            ).fetchone()
            if not destination:
                raise HTTPException(status_code=422, detail="destinationZoneId does not identify a warehouse zone")
        else:
            zones = connection.execute(
                "SELECT * FROM inventory.warehouse_zones WHERE site_id = %s AND zone_type = 'storage' ORDER BY zone_id",
                (WAREHOUSE_ID,),
            ).fetchall()
            destination = zones[order_number % len(zones)]
        robot = connection.execute(
            "SELECT * FROM inventory.agv_robots WHERE site_id = %s AND state = 'ready' ORDER BY battery DESC, robot_id LIMIT 1 FOR UPDATE",
            (WAREHOUSE_ID,),
        ).fetchone()
        target = {"x": destination["x"] + destination["width"] // 2, "y": destination["y"] + destination["depth"] // 2}
        route = route_between({"x": robot["x"], "y": robot["y"]}, target) if robot else []
        connection.execute(
            """INSERT INTO inventory.robot_missions
                 (mission_id, site_id, order_ref, robot_id, status, stage, progress, route, priority)
               VALUES (%s, %s, %s, %s, %s, %s, 0, %s, %s)""",
            (mission_id, WAREHOUSE_ID, order_ref, robot["robot_id"] if robot else None,
             "active" if robot else "queued", "routing" if robot else "queued", Jsonb(route), payload.priority),
        )
        if robot:
            connection.execute(
                "UPDATE inventory.agv_robots SET state = 'executing', current_mission_id = %s, updated_at = now() WHERE robot_id = %s",
                (mission_id, robot["robot_id"]),
            )
        lot = connection.execute(
            "SELECT lot_id FROM inventory.lots WHERE sku = %s ORDER BY lot_id LIMIT 1", (payload.sku,)
        ).fetchone()
        if not lot:
            lot = connection.execute("SELECT lot_id FROM inventory.lots ORDER BY lot_id LIMIT 1").fetchone()
        if lot:
            connection.execute(
                "INSERT INTO inventory.orders(order_id, lot_id, quantity, status) VALUES (%s, %s, %s, 'processing') ON CONFLICT (order_id) DO UPDATE SET status = 'processing'",
                (order_ref, lot["lot_id"], payload.quantity),
            )
        connection.execute(
            "UPDATE inventory.warehouse_sites SET orders_today = %s, updated_at = now() WHERE site_id = %s",
            (order_number, WAREHOUSE_ID),
        )
        assigned = robot["name"] if robot else "the queue"
        connection.execute(
            "INSERT INTO inventory.warehouse_activity(site_id, activity_type, message) VALUES (%s, 'order_received', %s)",
            (WAREHOUSE_ID, f"{order_ref}: {payload.quantity} × {payload.sku} created; {assigned} assigned."),
        )
    return _postgres_snapshot()


def _inject_anomaly_postgres(payload: AnomalyRequest) -> dict[str, Any]:
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL is not configured")
    with psycopg.connect(dsn, connect_timeout=2, row_factory=dict_row) as connection:
        if payload.robotId:
            robot = connection.execute(
                "SELECT * FROM inventory.agv_robots WHERE site_id = %s AND robot_id = %s FOR UPDATE",
                (WAREHOUSE_ID, payload.robotId),
            ).fetchone()
            if not robot:
                raise HTTPException(status_code=404, detail="robot not found")
        else:
            robot = connection.execute(
                "SELECT * FROM inventory.agv_robots WHERE site_id = %s AND state NOT IN ('offline', 'charging') ORDER BY CASE state WHEN 'executing' THEN 0 ELSE 1 END, robot_id LIMIT 1 FOR UPDATE",
                (WAREHOUSE_ID,),
            ).fetchone()
        site = connection.execute(
            "SELECT simulation_tick FROM inventory.warehouse_sites WHERE site_id = %s", (WAREHOUSE_ID,)
        ).fetchone()
        anomaly_count = connection.execute(
            "SELECT COUNT(*)::int AS count FROM inventory.warehouse_anomalies WHERE site_id = %s", (WAREHOUSE_ID,)
        ).fetchone()["count"]
        anomaly_id = f"ANOM-DEMO-{site['simulation_tick']}-{anomaly_count + 1}"
        message = payload.message or (f"{robot['name']} reported a blocked aisle and paused safely." if robot else "A blocked aisle was detected.")
        connection.execute(
            """INSERT INTO inventory.warehouse_anomalies
                 (anomaly_id, site_id, severity, anomaly_type, message, robot_id)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (anomaly_id, WAREHOUSE_ID, payload.severity, payload.type, message, robot["robot_id"] if robot else None),
        )
        if robot:
            connection.execute(
                "UPDATE inventory.agv_robots SET state = 'blocked', updated_at = now() WHERE robot_id = %s",
                (robot["robot_id"],),
            )
            if robot["current_mission_id"]:
                connection.execute(
                    "UPDATE inventory.robot_missions SET status = 'paused', stage = 'exception', updated_at = now() WHERE mission_id = %s AND status = 'active'",
                    (robot["current_mission_id"],),
                )
        connection.execute(
            "INSERT INTO inventory.warehouse_activity(site_id, activity_type, message) VALUES (%s, 'anomaly_detected', %s)",
            (WAREHOUSE_ID, message),
        )
    return _postgres_snapshot()


def _robot_action_postgres(robot_id: str, payload: RobotActionRequest) -> dict[str, Any]:
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL is not configured")
    with psycopg.connect(dsn, connect_timeout=2, row_factory=dict_row) as connection:
        robot = connection.execute(
            "SELECT * FROM inventory.agv_robots WHERE site_id = %s AND robot_id = %s FOR UPDATE",
            (WAREHOUSE_ID, robot_id),
        ).fetchone()
        if not robot:
            raise HTTPException(status_code=404, detail="robot not found")
        mission_id = robot["current_mission_id"]
        if payload.action == "pause":
            connection.execute("UPDATE inventory.agv_robots SET state = 'paused', updated_at = now() WHERE robot_id = %s", (robot_id,))
            if mission_id:
                connection.execute("UPDATE inventory.robot_missions SET status = 'paused', updated_at = now() WHERE mission_id = %s AND status = 'active'", (mission_id,))
        elif payload.action == "resume":
            connection.execute("UPDATE inventory.agv_robots SET state = %s, updated_at = now() WHERE robot_id = %s", ("executing" if mission_id else "ready", robot_id))
            if mission_id:
                connection.execute("UPDATE inventory.robot_missions SET status = 'active', stage = 'transporting', updated_at = now() WHERE mission_id = %s AND status = 'paused'", (mission_id,))
        elif payload.action == "clear_anomaly":
            connection.execute("UPDATE inventory.warehouse_anomalies SET resolved = true, resolved_at = now() WHERE site_id = %s AND robot_id = %s AND resolved = false", (WAREHOUSE_ID, robot_id))
            connection.execute("UPDATE inventory.agv_robots SET state = %s, updated_at = now() WHERE robot_id = %s", ("executing" if mission_id else "ready", robot_id))
            if mission_id:
                connection.execute("UPDATE inventory.robot_missions SET status = 'active', stage = 'transporting', updated_at = now() WHERE mission_id = %s AND status = 'paused'", (mission_id,))
        else:
            target_zone_id = "ZONE-CHARGING" if payload.action == "charge" else payload.targetZoneId
            zone = connection.execute(
                "SELECT * FROM inventory.warehouse_zones WHERE site_id = %s AND zone_id = %s",
                (WAREHOUSE_ID, target_zone_id),
            ).fetchone()
            if not zone:
                raise HTTPException(status_code=422, detail="targetZoneId is required and must identify a warehouse zone")
            site = connection.execute("SELECT simulation_tick FROM inventory.warehouse_sites WHERE site_id = %s", (WAREHOUSE_ID,)).fetchone()
            mission_count = connection.execute("SELECT COUNT(*)::int AS count FROM inventory.robot_missions WHERE site_id = %s", (WAREHOUSE_ID,)).fetchone()["count"]
            new_mission_id = f"MIS-{payload.action.upper()}-{robot_id}-{site['simulation_tick']}-{mission_count + 1}"
            target = {"x": zone["x"] + zone["width"] // 2, "y": zone["y"] + zone["depth"] // 2}
            route = route_between({"x": robot["x"], "y": robot["y"]}, target)
            if mission_id:
                connection.execute("UPDATE inventory.robot_missions SET status = 'cancelled', stage = 'superseded', updated_at = now() WHERE mission_id = %s AND status IN ('active', 'paused')", (mission_id,))
            connection.execute(
                """INSERT INTO inventory.robot_missions
                     (mission_id, site_id, order_ref, robot_id, status, stage, progress, route, priority)
                   VALUES (%s, %s, %s, %s, 'active', 'routing', 0, %s, 1)""",
                (new_mission_id, WAREHOUSE_ID, "BATTERY-RECOVERY" if payload.action == "charge" else "OPERATOR-DISPATCH", robot_id, Jsonb(route)),
            )
            connection.execute("UPDATE inventory.agv_robots SET state = 'executing', current_mission_id = %s, updated_at = now() WHERE robot_id = %s", (new_mission_id, robot_id))
        connection.execute(
            "INSERT INTO inventory.warehouse_activity(site_id, activity_type, message) VALUES (%s, 'robot_action', %s)",
            (WAREHOUSE_ID, f"{payload.action.replace('_', ' ').title()} sent to {robot['name']}."),
        )
    return _postgres_snapshot()


def _reset_postgres() -> dict[str, Any]:
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL is not configured")
    seed = _new_demo_state()
    with psycopg.connect(dsn, connect_timeout=2) as connection:
        connection.execute("UPDATE inventory.agv_robots SET current_mission_id = NULL WHERE site_id = %s", (WAREHOUSE_ID,))
        connection.execute("DELETE FROM inventory.robot_missions WHERE site_id = %s", (WAREHOUSE_ID,))
        for mission in seed["missions"]:
            connection.execute(
                """INSERT INTO inventory.robot_missions
                     (mission_id, site_id, order_ref, robot_id, status, stage, progress, route, priority)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (mission["id"], WAREHOUSE_ID, mission["orderRef"], mission["robotId"], mission["status"],
                 mission["stage"], mission["progress"], Jsonb(mission["route"]), mission["priority"]),
            )
        for robot in seed["robots"]:
            connection.execute(
                """UPDATE inventory.agv_robots SET x = %s, y = %s, heading = %s, battery = %s,
                          state = %s, current_mission_id = %s, updated_at = now() WHERE robot_id = %s""",
                (robot["x"], robot["y"], robot["heading"], robot["battery"], robot["state"], robot["currentMissionId"], robot["id"]),
            )
        connection.execute("DELETE FROM inventory.warehouse_anomalies WHERE site_id = %s", (WAREHOUSE_ID,))
        anomaly = seed["anomalies"][0]
        connection.execute(
            "INSERT INTO inventory.warehouse_anomalies(anomaly_id, site_id, severity, anomaly_type, message, robot_id) VALUES (%s, %s, %s, %s, %s, %s)",
            (anomaly["id"], WAREHOUSE_ID, anomaly["severity"], anomaly["type"], anomaly["message"], anomaly["robotId"]),
        )
        connection.execute("DELETE FROM inventory.warehouse_activity WHERE site_id = %s", (WAREHOUSE_ID,))
        for activity in reversed(seed["activity"]):
            connection.execute(
                "INSERT INTO inventory.warehouse_activity(site_id, activity_type, message) VALUES (%s, %s, %s)",
                (WAREHOUSE_ID, activity["type"], activity["message"]),
            )
        connection.execute("DELETE FROM inventory.orders WHERE order_id LIKE 'ORD-DEMO-%'")
        connection.execute(
            "UPDATE inventory.warehouse_sites SET running = true, mode = 'demo', simulation_tick = 0, orders_today = 148, updated_at = now() WHERE site_id = %s",
            (WAREHOUSE_ID,),
        )
    return _postgres_snapshot()


def _prepare_remediation_memory(incident_id: str, payload: PrepareRemediationRequest) -> dict[str, Any]:
    with _state_lock:
        incident = _incident_or_404(incident_id)
        if incident["status"] == "RESOLVED":
            raise HTTPException(status_code=409, detail="resolved incidents cannot accept remediation")
        robot_id = incident.get("robotId")
        if not robot_id:
            raise HTTPException(status_code=422, detail="incident has no robot target")
        if payload.targetRobotId and payload.targetRobotId != robot_id:
            raise HTTPException(status_code=409, detail="targetRobotId must exactly match the incident robot")
        if not any(robot["id"] == robot_id for robot in _demo_state["robots"]):
            raise HTTPException(status_code=404, detail="target robot not found")
        store = _authoritative_mutation_store()
        if payload.action == "reroute_robot":
            if not payload.targetZoneId or not any(zone["id"] == payload.targetZoneId for zone in _demo_state["zones"]):
                raise HTTPException(status_code=422, detail="reroute_robot requires a valid targetZoneId")

        canonical = f"{incident_id}\0{payload.action}\0{robot_id}\0{payload.targetZoneId or ''}"
        idem_key = f"oncall:{hashlib.sha256(canonical.encode()).hexdigest()}"
        existing = next(
            (intent for intent in incident["remediationIntents"] if intent["idempotencyKey"] == idem_key),
            None,
        )
        if existing:
            if payload.actionIntentId and payload.actionIntentId != existing["id"]:
                raise HTTPException(status_code=409, detail="remediation already has a different action intent id")
            _persist_incident(incident, required=store == "postgres")
            return {"incident": copy.deepcopy(incident), "actionIntent": copy.deepcopy(existing), "idempotent": True}

        intent_id = payload.actionIntentId or f"ONCALL-{hashlib.sha256(idem_key.encode()).hexdigest()[:20].upper()}"
        if any(
            intent["id"] == intent_id
            for item in _demo_state["incidents"]
            for intent in item["remediationIntents"]
        ):
            raise HTTPException(status_code=409, detail="actionIntentId already belongs to another remediation")
        now = utc_now()
        intent = {
            "id": intent_id,
            "incidentId": incident_id,
            "action": payload.action,
            "targetRobotId": robot_id,
            "targetZoneId": payload.targetZoneId,
            "rationale": payload.rationale,
            "scope": payload.scope,
            "rollback": payload.rollback,
            "risk": payload.risk,
            "state": "PENDING_APPROVAL",
            "integrityMode": payload.integrityMode,
            "idempotencyKey": idem_key,
            "createdAt": now,
            "approvedBy": None,
            "approvedAt": None,
            "appliedAt": None,
            "outcome": None,
            "beforeSnapshot": _capture_authoritative_action_state(store, incident, robot_id),
        }
        incident["remediationIntents"].append(intent)
        incident["remediation"] = {
            "intentId": intent_id,
            "action": payload.action,
            "targetRobotId": robot_id,
            "targetZoneId": payload.targetZoneId,
            "rationale": payload.rationale,
            "scope": payload.scope,
            "rollback": payload.rollback,
            "risk": payload.risk,
            "state": "PENDING_APPROVAL",
            "integrityMode": payload.integrityMode,
        }
        incident["status"] = "AWAITING_APPROVAL"
        _set_runbook_step(incident, "prepare", "DONE")
        _set_runbook_step(incident, "execute", "AWAITING_APPROVAL")
        _incident_event(
            incident,
            "remediation_prepared",
            "relaygrid-oncall",
            f"Prepared {payload.action} for {robot_id}; action {intent_id} is awaiting explicit approval.",
        )
        _activity(_demo_state, "remediation_prepared", f"{incident_id} prepared {payload.action} for {robot_id}.")
        _persist_incident(incident, required=store == "postgres")
        return {"incident": copy.deepcopy(incident), "actionIntent": copy.deepcopy(intent), "idempotent": False}


def _capture_authoritative_action_state(
    store: str,
    incident: dict[str, Any],
    robot_id: str,
) -> dict[str, Any]:
    if store == "postgres":
        dsn = os.getenv("DATABASE_URL")
        if not dsn:
            raise RuntimeError("DATABASE_URL is not configured")
        with psycopg.connect(dsn, connect_timeout=2, row_factory=dict_row) as connection:
            robot = connection.execute(
                "SELECT robot_id, state, current_mission_id, x, y, battery FROM inventory.agv_robots WHERE robot_id = %s",
                (robot_id,),
            ).fetchone()
            if not robot:
                raise RuntimeError("target robot not found in postgres warehouse")
            mission = None
            if robot["current_mission_id"]:
                mission = connection.execute(
                    """SELECT mission_id, order_ref, status, stage, progress, route
                       FROM inventory.robot_missions WHERE mission_id = %s""",
                    (robot["current_mission_id"],),
                ).fetchone()
            anomaly = connection.execute(
                "SELECT anomaly_id, resolved FROM inventory.warehouse_anomalies WHERE anomaly_id = %s",
                (incident.get("anomalyId"),),
            ).fetchone()
            return _jsonable({
                "store": "postgres", "robot": dict(robot),
                "mission": dict(mission) if mission else None,
                "anomaly": dict(anomaly) if anomaly else None,
            })
    robot = next((item for item in _demo_state["robots"] if item["id"] == robot_id), None)
    if not robot:
        raise RuntimeError("target robot not found in demo-memory warehouse")
    mission = next(
        (item for item in _demo_state["missions"] if item["id"] == robot.get("currentMissionId")),
        None,
    )
    anomaly = next(
        (item for item in _demo_state["anomalies"] if item["id"] == incident.get("anomalyId")),
        None,
    )
    return _jsonable({
        "store": "demo-memory", "robot": robot,
        "mission": mission, "anomaly": anomaly,
    })


def _receipt_id(intent_id: str) -> str:
    return f"RCP-{hashlib.sha256(intent_id.encode()).hexdigest()[:24].upper()}"


def _jsonable(value: Any) -> Any:
    return json.loads(json.dumps(value, default=lambda item: item.isoformat() if hasattr(item, "isoformat") else str(item)))


def _receipt_proof(receipt: dict[str, Any]) -> dict[str, Any]:
    return {
        "receiptId": receipt["receiptId"],
        "actionIntentId": receipt["actionIntentId"],
        "store": receipt["store"],
        "appliedAt": receipt["appliedAt"],
        "evidenceHash": receipt["evidenceHash"],
    }


def _receipt_digest(receipt: dict[str, Any]) -> str:
    material = {key: value for key, value in receipt.items() if key != "evidenceHash"}
    return hashlib.sha256(
        json.dumps(material, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def _finalize_receipt(receipt: dict[str, Any]) -> dict[str, Any]:
    receipt["evidenceHash"] = _receipt_digest(receipt)
    return receipt


def _apply_memory_remediation(incident: dict[str, Any], intent: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    existing = next(
        (item for item in _demo_state["remediationReceipts"] if item["actionIntentId"] == intent["id"]),
        None,
    )
    if existing:
        return copy.deepcopy(existing), True
    robot = next((item for item in _demo_state["robots"] if item["id"] == intent["targetRobotId"]), None)
    if not robot:
        raise RuntimeError("target robot not found in demo-memory warehouse")
    current_mission = next(
        (item for item in _demo_state["missions"] if item["id"] == robot.get("currentMissionId")),
        None,
    )
    incident_anomaly = next(
        (item for item in _demo_state["anomalies"] if item["id"] == incident.get("anomalyId")),
        None,
    )
    before = {
        "robot": copy.deepcopy(robot), "mission": copy.deepcopy(current_mission),
        "anomaly": copy.deepcopy(incident_anomaly),
    }
    action = intent["action"]
    if action == "pause_robot":
        robot["state"] = "paused"
        if current_mission and current_mission["status"] == "active":
            current_mission["status"] = "paused"
    elif action == "send_to_charging":
        zone = next((item for item in _demo_state["zones"] if item["id"] == "ZONE-CHARGING"), None)
        if not zone:
            raise RuntimeError("charging zone not found")
        if current_mission and current_mission["status"] == "active":
            current_mission["status"] = "paused"
            current_mission["stage"] = "battery_hold"
        mission_id = f"MIS-CHARGE-{hashlib.sha256(intent['id'].encode()).hexdigest()[:12].upper()}"
        mission = {
            "id": mission_id, "orderRef": "BATTERY-RECOVERY", "robotId": robot["id"],
            "status": "active", "stage": "routing", "progress": 0,
            "route": route_between(
                {"x": robot["x"], "y": robot["y"]},
                {"x": zone["x"] + zone["width"] // 2, "y": zone["y"] + zone["depth"] // 2},
            ),
            "priority": 1,
        }
        _demo_state["missions"].insert(0, mission)
        robot["state"] = "executing"
        robot["currentMissionId"] = mission_id
    elif action == "clear_robot_anomaly":
        anomaly = incident_anomaly
        if not anomaly or anomaly.get("robotId") != robot["id"]:
            raise RuntimeError("incident anomaly does not match the target robot")
        if anomaly.get("resolved"):
            raise RuntimeError("incident anomaly was already resolved without this action receipt")
        anomaly["resolved"] = True
        other_open = any(
            item["id"] != anomaly["id"] and item.get("robotId") == robot["id"] and not item.get("resolved")
            for item in _demo_state["anomalies"]
        )
        if not other_open:
            robot["state"] = "executing" if current_mission else "ready"
            if current_mission and current_mission["status"] == "paused":
                current_mission["status"] = "active"
                current_mission["stage"] = "transporting"
    else:
        if not current_mission or current_mission["status"] not in ("active", "paused"):
            raise RuntimeError("reroute requires the incident robot's current mission")
        zone = next((item for item in _demo_state["zones"] if item["id"] == intent.get("targetZoneId")), None)
        if not zone:
            raise RuntimeError("reroute target zone not found")
        current_mission["route"] = route_between(
            {"x": robot["x"], "y": robot["y"]},
            {"x": zone["x"] + zone["width"] // 2, "y": zone["y"] + zone["depth"] // 2},
        )
        current_mission["status"] = "active"
        current_mission["stage"] = "rerouting"
        robot["state"] = "executing"

    if action in ("send_to_charging", "reroute_robot") and incident_anomaly:
        if incident_anomaly.get("robotId") != robot["id"]:
            raise RuntimeError("incident anomaly does not match the target robot")
        incident_anomaly["resolved"] = True

    after_mission = next(
        (item for item in _demo_state["missions"] if item["id"] == robot.get("currentMissionId")),
        None,
    )
    target_zone = next((item for item in _demo_state["zones"] if item["id"] == intent.get("targetZoneId")), None)
    postcondition = (
        robot["state"] == "paused" if action == "pause_robot"
        else bool(after_mission and after_mission["orderRef"] == "BATTERY-RECOVERY") if action == "send_to_charging"
        else bool(anomaly.get("resolved")) if action == "clear_robot_anomaly"
        else bool(
            before["mission"] and after_mission and after_mission["id"] == before["mission"]["id"]
            and after_mission["orderRef"] == before["mission"]["orderRef"]
            and after_mission["progress"] == before["mission"]["progress"]
            and target_zone and after_mission["route"][-1] == {
                "x": target_zone["x"] + target_zone["width"] // 2,
                "y": target_zone["y"] + target_zone["depth"] // 2,
            }
        )
    )
    if not postcondition:
        raise RuntimeError("remediation postcondition was not satisfied")
    receipt = _finalize_receipt({
        "receiptId": _receipt_id(intent["id"]), "actionIntentId": intent["id"],
        "incidentId": incident["id"], "action": action, "targetRobotId": robot["id"],
        "targetZoneId": intent.get("targetZoneId"), "store": "demo-memory", "appliedAt": utc_now(),
        "before": before,
        "after": {
            "robot": copy.deepcopy(robot), "mission": copy.deepcopy(after_mission),
            "anomaly": copy.deepcopy(incident_anomaly),
        },
        "incidentAnomalyId": incident.get("anomalyId"),
        "postcondition": {"verified": True, "verifiedAt": utc_now()},
    })
    _demo_state["remediationReceipts"].append(copy.deepcopy(receipt))
    _activity(_demo_state, "robot_action", f"{action.replace('_', ' ').title()} applied to {robot['name']} by {intent['id']}.")
    return receipt, False


def _receipt_from_postgres_row(row: dict[str, Any]) -> dict[str, Any]:
    evidence = copy.deepcopy(row["evidence"])
    evidence.update({
        "receiptId": row["receipt_id"], "actionIntentId": row["action_intent_id"],
        "incidentId": row["incident_id"], "action": row["action_type"],
        "targetRobotId": row["target_robot_id"], "targetZoneId": row["target_zone_id"],
        "store": "postgres", "appliedAt": row["applied_at"].isoformat(),
    })
    return evidence


def _apply_postgres_remediation(incident: dict[str, Any], intent: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL is not configured")
    with psycopg.connect(dsn, connect_timeout=2, row_factory=dict_row) as connection:
        _ensure_oncall_tables(connection)
        existing = connection.execute(
            "SELECT * FROM inventory.remediation_receipts WHERE action_intent_id = %s",
            (intent["id"],),
        ).fetchone()
        if existing:
            return _receipt_from_postgres_row(existing), True
        robot = connection.execute(
            "SELECT * FROM inventory.agv_robots WHERE site_id = %s AND robot_id = %s FOR UPDATE",
            (WAREHOUSE_ID, intent["targetRobotId"]),
        ).fetchone()
        if not robot:
            raise RuntimeError("target robot not found in postgres warehouse")
        current_mission = None
        if robot["current_mission_id"]:
            current_mission = connection.execute(
                "SELECT * FROM inventory.robot_missions WHERE mission_id = %s FOR UPDATE",
                (robot["current_mission_id"],),
            ).fetchone()
        incident_anomaly = connection.execute(
            "SELECT * FROM inventory.warehouse_anomalies WHERE anomaly_id = %s FOR UPDATE",
            (incident.get("anomalyId"),),
        ).fetchone()
        before = {
            "robot": dict(robot), "mission": dict(current_mission) if current_mission else None,
            "anomaly": dict(incident_anomaly) if incident_anomaly else None,
        }
        action = intent["action"]
        if action == "pause_robot":
            connection.execute(
                "UPDATE inventory.agv_robots SET state = 'paused', updated_at = now() WHERE robot_id = %s",
                (robot["robot_id"],),
            )
            if current_mission and current_mission["status"] == "active":
                connection.execute(
                    "UPDATE inventory.robot_missions SET status = 'paused', updated_at = now() WHERE mission_id = %s",
                    (current_mission["mission_id"],),
                )
        elif action == "send_to_charging":
            zone = connection.execute(
                "SELECT * FROM inventory.warehouse_zones WHERE site_id = %s AND zone_id = 'ZONE-CHARGING'",
                (WAREHOUSE_ID,),
            ).fetchone()
            if not zone:
                raise RuntimeError("charging zone not found")
            if current_mission and current_mission["status"] == "active":
                connection.execute(
                    "UPDATE inventory.robot_missions SET status = 'paused', stage = 'battery_hold', updated_at = now() WHERE mission_id = %s",
                    (current_mission["mission_id"],),
                )
            mission_id = f"MIS-CHARGE-{hashlib.sha256(intent['id'].encode()).hexdigest()[:12].upper()}"
            route = route_between(
                {"x": robot["x"], "y": robot["y"]},
                {"x": zone["x"] + zone["width"] // 2, "y": zone["y"] + zone["depth"] // 2},
            )
            connection.execute(
                """INSERT INTO inventory.robot_missions
                     (mission_id, site_id, order_ref, robot_id, status, stage, progress, route, priority)
                   VALUES (%s, %s, 'BATTERY-RECOVERY', %s, 'active', 'routing', 0, %s, 1)""",
                (mission_id, WAREHOUSE_ID, robot["robot_id"], Jsonb(route)),
            )
            connection.execute(
                "UPDATE inventory.agv_robots SET state = 'executing', current_mission_id = %s, updated_at = now() WHERE robot_id = %s",
                (mission_id, robot["robot_id"]),
            )
        elif action == "clear_robot_anomaly":
            anomaly = incident_anomaly
            if not anomaly or anomaly["robot_id"] != robot["robot_id"]:
                raise RuntimeError("incident anomaly does not match the target robot")
            if anomaly["resolved"]:
                raise RuntimeError("incident anomaly was already resolved without this action receipt")
            connection.execute(
                "UPDATE inventory.warehouse_anomalies SET resolved = true, resolved_at = now() WHERE anomaly_id = %s",
                (anomaly["anomaly_id"],),
            )
            other_open = connection.execute(
                "SELECT COUNT(*)::int AS count FROM inventory.warehouse_anomalies WHERE robot_id = %s AND anomaly_id <> %s AND resolved = false",
                (robot["robot_id"], anomaly["anomaly_id"]),
            ).fetchone()["count"]
            if other_open == 0:
                next_state = "executing" if current_mission else "ready"
                connection.execute(
                    "UPDATE inventory.agv_robots SET state = %s, updated_at = now() WHERE robot_id = %s",
                    (next_state, robot["robot_id"]),
                )
                if current_mission and current_mission["status"] == "paused":
                    connection.execute(
                        "UPDATE inventory.robot_missions SET status = 'active', stage = 'transporting', updated_at = now() WHERE mission_id = %s",
                        (current_mission["mission_id"],),
                    )
        else:
            if not current_mission or current_mission["status"] not in ("active", "paused"):
                raise RuntimeError("reroute requires the incident robot's current mission")
            zone = connection.execute(
                "SELECT * FROM inventory.warehouse_zones WHERE site_id = %s AND zone_id = %s",
                (WAREHOUSE_ID, intent.get("targetZoneId")),
            ).fetchone()
            if not zone:
                raise RuntimeError("reroute target zone not found")
            route = route_between(
                {"x": robot["x"], "y": robot["y"]},
                {"x": zone["x"] + zone["width"] // 2, "y": zone["y"] + zone["depth"] // 2},
            )
            connection.execute(
                """UPDATE inventory.robot_missions
                     SET route = %s, status = 'active', stage = 'rerouting', updated_at = now()
                     WHERE mission_id = %s""",
                (Jsonb(route), current_mission["mission_id"]),
            )
            connection.execute(
                "UPDATE inventory.agv_robots SET state = 'executing', updated_at = now() WHERE robot_id = %s",
                (robot["robot_id"],),
            )

        if action in ("send_to_charging", "reroute_robot") and incident_anomaly:
            if incident_anomaly["robot_id"] != robot["robot_id"]:
                raise RuntimeError("incident anomaly does not match the target robot")
            connection.execute(
                "UPDATE inventory.warehouse_anomalies SET resolved = true, resolved_at = now() WHERE anomaly_id = %s",
                (incident_anomaly["anomaly_id"],),
            )

        after_robot = connection.execute(
            "SELECT * FROM inventory.agv_robots WHERE robot_id = %s", (robot["robot_id"],)
        ).fetchone()
        after_mission = None
        if after_robot["current_mission_id"]:
            after_mission = connection.execute(
                "SELECT * FROM inventory.robot_missions WHERE mission_id = %s", (after_robot["current_mission_id"],)
            ).fetchone()
        after_anomaly = connection.execute(
            "SELECT * FROM inventory.warehouse_anomalies WHERE anomaly_id = %s",
            (incident.get("anomalyId"),),
        ).fetchone()
        target_zone = None
        if intent.get("targetZoneId"):
            target_zone = connection.execute(
                "SELECT * FROM inventory.warehouse_zones WHERE site_id = %s AND zone_id = %s",
                (WAREHOUSE_ID, intent["targetZoneId"]),
            ).fetchone()
        anomaly_resolved = None
        if action == "clear_robot_anomaly":
            anomaly_resolved = connection.execute(
                "SELECT resolved FROM inventory.warehouse_anomalies WHERE anomaly_id = %s",
                (incident.get("anomalyId"),),
            ).fetchone()
        postcondition = (
            after_robot["state"] == "paused" if action == "pause_robot"
            else bool(after_mission and after_mission["order_ref"] == "BATTERY-RECOVERY") if action == "send_to_charging"
            else bool(anomaly_resolved and anomaly_resolved["resolved"]) if action == "clear_robot_anomaly"
            else bool(
                current_mission and after_mission
                and after_mission["mission_id"] == current_mission["mission_id"]
                and after_mission["order_ref"] == current_mission["order_ref"]
                and after_mission["progress"] == current_mission["progress"]
                and target_zone and after_mission["route"][-1] == {
                    "x": target_zone["x"] + target_zone["width"] // 2,
                    "y": target_zone["y"] + target_zone["depth"] // 2,
                }
            )
        )
        if not postcondition:
            raise RuntimeError("remediation postcondition was not satisfied")
        applied_at = utc_now()
        receipt = _finalize_receipt({
            "receiptId": _receipt_id(intent["id"]), "actionIntentId": intent["id"],
            "incidentId": incident["id"], "action": action, "targetRobotId": robot["robot_id"],
            "targetZoneId": intent.get("targetZoneId"), "store": "postgres", "appliedAt": applied_at,
            "before": _jsonable(before),
            "after": _jsonable({
                "robot": dict(after_robot), "mission": dict(after_mission) if after_mission else None,
                "anomaly": dict(after_anomaly) if after_anomaly else None,
            }),
            "incidentAnomalyId": incident.get("anomalyId"),
            "postcondition": {"verified": True, "verifiedAt": applied_at},
        })
        connection.execute(
            """INSERT INTO inventory.remediation_receipts
                 (action_intent_id, receipt_id, incident_id, site_id, action_type,
                  target_robot_id, target_zone_id, evidence, applied_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                intent["id"], receipt["receiptId"], incident["id"], WAREHOUSE_ID, action,
                robot["robot_id"], intent.get("targetZoneId"), Jsonb({
                    key: value for key, value in receipt.items()
                    if key not in ("receiptId", "actionIntentId", "incidentId", "action", "targetRobotId", "targetZoneId", "store", "appliedAt")
                }), datetime.fromisoformat(applied_at),
            ),
        )
        connection.execute(
            "INSERT INTO inventory.warehouse_activity(site_id, activity_type, message) VALUES (%s, 'robot_action', %s)",
            (WAREHOUSE_ID, f"{action.replace('_', ' ').title()} applied to {robot['name']} by {intent['id']}."),
        )
        return receipt, False


def _read_receipt_for_store(store: str, intent_id: str) -> dict[str, Any] | None:
    if store == "postgres":
        dsn = os.getenv("DATABASE_URL")
        if not dsn:
            return None
        with psycopg.connect(dsn, connect_timeout=2, row_factory=dict_row) as connection:
            _ensure_oncall_tables(connection)
            row = connection.execute(
                "SELECT * FROM inventory.remediation_receipts WHERE action_intent_id = %s", (intent_id,)
            ).fetchone()
            return _receipt_from_postgres_row(row) if row else None
    receipt = next(
        (item for item in _demo_state["remediationReceipts"] if item["actionIntentId"] == intent_id),
        None,
    )
    return copy.deepcopy(receipt) if receipt else None


def _read_current_postcondition(store: str, incident: dict[str, Any], intent: dict[str, Any]) -> dict[str, Any]:
    try:
        if store == "postgres":
            snapshot = _postgres_snapshot()
            dsn = os.getenv("DATABASE_URL")
            anomaly_resolved = None
            if intent["action"] == "clear_robot_anomaly" and dsn:
                with psycopg.connect(dsn, connect_timeout=2, row_factory=dict_row) as connection:
                    row = connection.execute(
                        "SELECT resolved FROM inventory.warehouse_anomalies WHERE anomaly_id = %s",
                        (incident.get("anomalyId"),),
                    ).fetchone()
                    anomaly_resolved = bool(row and row["resolved"])
        else:
            snapshot = _memory_snapshot()
            anomaly = next(
                (item for item in _demo_state["anomalies"] if item["id"] == incident.get("anomalyId")),
                None,
            )
            anomaly_resolved = bool(anomaly and anomaly.get("resolved"))
        robot = next((item for item in snapshot["robots"] if item["id"] == intent["targetRobotId"]), None)
        mission = next(
            (item for item in snapshot["missions"] if robot and item["id"] == robot.get("currentMissionId")),
            None,
        )
        target_zone = next(
            (item for item in snapshot["zones"] if item["id"] == intent.get("targetZoneId")),
            None,
        )
        action = intent["action"]
        matches = (
            bool(robot and robot["state"] == "paused") if action == "pause_robot"
            else bool(
                robot and (robot["state"] == "charging" or (mission and mission["orderRef"] == "BATTERY-RECOVERY"))
            ) if action == "send_to_charging"
            else bool(anomaly_resolved) if action == "clear_robot_anomaly"
            else bool(
                mission and mission["id"] == incident.get("missionId") and target_zone and mission["route"]
                and mission["route"][-1] == {
                    "x": target_zone["x"] + target_zone["width"] // 2,
                    "y": target_zone["y"] + target_zone["depth"] // 2,
                }
            )
        )
        return {
            "store": store, "matchesRequestedPostcondition": matches,
            "robotState": robot["state"] if robot else None,
            "missionId": mission["id"] if mission else None,
            "observedAt": utc_now(),
        }
    except (psycopg.Error, RuntimeError, KeyError) as error:
        return {"store": store, "matchesRequestedPostcondition": None, "error": str(error), "observedAt": utc_now()}


def _source_anomaly_resolved(store: str, incident: dict[str, Any]) -> bool:
    anomaly_id = incident.get("anomalyId")
    if not anomaly_id:
        return False
    if store == "postgres":
        dsn = os.getenv("DATABASE_URL")
        if not dsn:
            raise RuntimeError("DATABASE_URL is not configured")
        with psycopg.connect(dsn, connect_timeout=2, row_factory=dict_row) as connection:
            row = connection.execute(
                "SELECT resolved FROM inventory.warehouse_anomalies WHERE anomaly_id = %s",
                (anomaly_id,),
            ).fetchone()
            return bool(row and row["resolved"])
    anomaly = next((item for item in _demo_state["anomalies"] if item["id"] == anomaly_id), None)
    return bool(anomaly and anomaly.get("resolved"))


def _apply_receipt_verdict(incident: dict[str, Any], intent: dict[str, Any], receipt: dict[str, Any] | None) -> dict[str, Any]:
    exact = bool(
        receipt
        and receipt.get("actionIntentId") == intent["id"]
        and receipt.get("incidentId") == incident["id"]
        and receipt.get("action") == intent["action"]
        and receipt.get("targetRobotId") == intent["targetRobotId"]
        and receipt.get("evidenceHash")
        and receipt.get("evidenceHash") == _receipt_digest(receipt)
    )
    before_snapshot = intent.get("beforeSnapshot")
    current_snapshot = None
    authoritatively_unchanged = False
    if not exact and receipt is None and isinstance(before_snapshot, dict):
        try:
            current_store = _authoritative_mutation_store()
            if before_snapshot.get("store") == current_store:
                current_snapshot = _capture_authoritative_action_state(
                    current_store, incident, intent["targetRobotId"]
                )
                authoritatively_unchanged = current_snapshot == before_snapshot
        except (psycopg.Error, RuntimeError, KeyError):
            authoritatively_unchanged = False
    state = "APPLIED" if exact else "NOT_APPLIED" if authoritatively_unchanged else "UNKNOWN"
    detail = (
        f"Atomic remediation receipt {receipt['receiptId']} attributes this mutation to intent {intent['id']}."
        if exact else
        "No action receipt exists and the authoritative warehouse state exactly matches the pre-action snapshot."
        if authoritatively_unchanged else
        "No valid atomic receipt exists and the authoritative state cannot prove that the action was not applied."
    )
    outcome = {
        "state": state,
        "attributableProof": _receipt_proof(receipt) if exact and receipt else None,
        "detail": detail,
        "currentStateEvidence": (
            _read_current_postcondition(receipt["store"], incident, intent)
            if exact and receipt else
            {"unchangedFromBeforeSnapshot": True, "snapshot": current_snapshot}
            if authoritatively_unchanged else None
        ),
        "verifiedAt": utc_now(),
    }
    intent["state"] = state
    intent["appliedAt"] = receipt["appliedAt"] if exact and receipt else None
    intent["outcome"] = outcome
    incident["remediation"] = {
        **(incident.get("remediation") or {}),
        "state": state,
        "verification": copy.deepcopy(outcome),
    }
    if exact and receipt:
        incident["status"] = "REMEDIATING"
        _set_runbook_step(incident, "execute", "DONE")
        _set_runbook_step(incident, "verify", "ACTIVE")
        evidence_id = f"EVD-{incident['id']}-{receipt['receiptId']}"
        if not any(item["id"] == evidence_id for item in incident["evidence"]):
            incident["evidence"].append({
                "id": evidence_id, "kind": "remediation_receipt", "title": "Atomic attributable remediation receipt",
                "detail": f"{detail} evidenceHash={receipt['evidenceHash']}",
                "source": f"{receipt['store']}/remediation_receipts", "createdAt": receipt["appliedAt"], "confidence": 1.0,
            })
            _incident_event(incident, "remediation_applied", "relaygrid-reconciler", detail)
    else:
        incident["status"] = "ESCALATED"
        _set_runbook_step(incident, "execute", state)
        if not any(item.get("actionIntentId") == intent["id"] and not item.get("resolvedAt") for item in incident["escalations"]):
            incident["escalations"].append({
                "id": f"ESC-{incident['id']}-{len(incident['escalations']) + 1}",
                "actionIntentId": intent["id"], "actor": "relaygrid-reconciler",
                "target": "warehouse-incident-commander", "reason": detail,
                "createdAt": utc_now(), "resolvedAt": None,
            })
            _incident_event(
                incident,
                "remediation_not_applied" if state == "NOT_APPLIED" else "outcome_unknown",
                "relaygrid-reconciler",
                f"{detail} No action was retried.",
            )
    return outcome


def _reconcile_remediation(incident_id: str, intent_id: str) -> dict[str, Any]:
    with _state_lock:
        incident = _incident_or_404(incident_id)
        intent = next((item for item in incident["remediationIntents"] if item["id"] == intent_id), None)
        if not intent:
            raise HTTPException(status_code=404, detail="remediation intent not found")
        store = _authoritative_mutation_store()
        receipt = _read_receipt_for_store(store, intent_id)
        outcome = _apply_receipt_verdict(incident, intent, receipt)
        _persist_incident(incident, required=store == "postgres")
        return {
            "incident": copy.deepcopy(incident), "actionIntent": copy.deepcopy(intent),
            "verification": copy.deepcopy(outcome), "reconciled": True, "executed": False,
        }


def _execute_remediation(
    incident_id: str,
    intent_id: str,
    payload: ExecuteRemediationRequest,
) -> dict[str, Any]:
    with _state_lock:
        incident = _incident_or_404(incident_id)
        intent = next((item for item in incident["remediationIntents"] if item["id"] == intent_id), None)
        if not intent:
            raise HTTPException(status_code=404, detail="remediation intent not found")
        if intent["state"] in ("EXECUTING", "APPLIED", "NOT_APPLIED", "UNKNOWN"):
            return _reconcile_remediation(incident_id, intent_id)
        if intent["state"] != "PENDING_APPROVAL":
            raise HTTPException(status_code=409, detail=f"remediation cannot execute from state {intent['state']}")
        store = _authoritative_mutation_store()
        intent["state"] = "EXECUTING"
        intent["approvedBy"] = payload.approvedBy
        intent["approvedAt"] = utc_now()
        incident["status"] = "REMEDIATING"
        _set_runbook_step(incident, "execute", "ACTIVE")
        _incident_event(
            incident, "remediation_approved", payload.approvedBy,
            f"Approved exact action {intent_id}: {intent['action']} on {intent['targetRobotId']}.",
        )
        _persist_incident(incident, required=store == "postgres")
        try:
            if store == "postgres":
                receipt, idempotent = _apply_postgres_remediation(incident, intent)
            else:
                receipt, idempotent = _apply_memory_remediation(incident, intent)
            outcome = _apply_receipt_verdict(incident, intent, receipt)
            incident["remediation"] = {
                **(incident.get("remediation") or {}),
                "approvedBy": payload.approvedBy,
                "approvalNote": payload.approvalNote,
            }
            _persist_incident(incident, required=store == "postgres")
            return {
                "incident": copy.deepcopy(incident), "actionIntent": copy.deepcopy(intent),
                "verification": copy.deepcopy(outcome), "idempotent": idempotent,
            }
        except Exception as error:
            intent["state"] = "UNKNOWN"
            intent["outcome"] = {
                "state": "UNKNOWN", "attributableProof": None,
                "detail": f"Execution result requires receipt reconciliation: {error}", "verifiedAt": utc_now(),
            }
            incident["status"] = "ESCALATED"
            _set_runbook_step(incident, "execute", "UNKNOWN")
            _incident_event(
                incident, "outcome_unknown", "relaygrid-reconciler",
                "Execution returned without attributable proof. The action was not retried.",
            )
            _persist_incident(incident, required=False)
            return {
                "incident": copy.deepcopy(incident), "actionIntent": copy.deepcopy(intent),
                "verification": copy.deepcopy(intent["outcome"]), "idempotent": False,
            }


@app.get("/health")
def health() -> dict[str, str]:
    snapshot = warehouse_snapshot()
    return {"service": "relaygrid-impact-engine", "status": "ok", "store": snapshot["meta"]["source"]}


@app.get("/v1/oncall/summary")
def get_oncall_summary() -> dict[str, Any]:
    store = warehouse_snapshot()["meta"]["source"]
    with _state_lock:
        summary = _serialize_state(_demo_state, "demo-memory")["onCall"]
        summary["meta"] = {"source": store, "generatedAt": utc_now()}
        return summary


@app.get("/v1/oncall/incidents")
def list_oncall_incidents(status: str | None = None, severity: str | None = None) -> dict[str, Any]:
    store = warehouse_snapshot()["meta"]["source"]
    with _state_lock:
        items = copy.deepcopy(_demo_state["incidents"])
    if status:
        items = [item for item in items if item["status"] == status.upper()]
    if severity:
        items = [item for item in items if item["severity"] == severity.upper()]
    return {"items": items, "total": len(items), "meta": {"source": store, "generatedAt": utc_now()}}


@app.get("/v1/oncall/incidents/{incident_id}")
def get_oncall_incident(incident_id: str) -> dict[str, Any]:
    with _state_lock:
        return copy.deepcopy(_incident_or_404(incident_id))


@app.get("/v1/oncall/memory")
def get_oncall_memory(fingerprint: str | None = None, limit: int = 10) -> dict[str, Any]:
    bounded_limit = max(1, min(limit, 50))
    with _state_lock:
        items = copy.deepcopy(_demo_state["incidentMemory"])
    if fingerprint:
        items = [item for item in items if item["fingerprint"] == fingerprint]
    items = list(reversed(items))[:bounded_limit]
    return {"items": items, "total": len(items), "meta": {"source": "demo-memory", "generatedAt": utc_now()}}


@app.post("/v1/oncall/detect")
def detect_oncall_incidents(payload: IncidentDetectRequest) -> dict[str, Any]:
    snapshot = warehouse_snapshot()
    candidates = snapshot["anomalies"]
    if payload.anomalyId:
        candidates = [item for item in candidates if item.get("id") == payload.anomalyId]
        if not candidates:
            raise HTTPException(status_code=404, detail="open anomaly not found")
    created: list[dict[str, Any]] = []
    existing: list[dict[str, Any]] = []
    with _state_lock:
        for anomaly in candidates:
            incident, was_created = _open_incident_for_anomaly_locked(anomaly)
            (created if was_created else existing).append(copy.deepcopy(incident))
    return {
        "created": created,
        "existing": existing,
        "detected": len(candidates),
        "meta": {"source": "demo-memory", "generatedAt": utc_now()},
    }


@app.post("/v1/oncall/incidents/{incident_id}/acknowledge")
def acknowledge_oncall_incident(incident_id: str, payload: IncidentAcknowledgeRequest) -> dict[str, Any]:
    with _state_lock:
        incident = _incident_or_404(incident_id)
        if incident["status"] == "RESOLVED":
            raise HTTPException(status_code=409, detail="resolved incident cannot be acknowledged")
        if not incident["acknowledgedAt"]:
            incident["acknowledgedAt"] = utc_now()
        incident["owner"] = payload.actor
        if incident["status"] == "OPEN":
            incident["status"] = "ACKNOWLEDGED"
        _set_runbook_step(incident, "ack", "DONE")
        _set_runbook_step(incident, "investigate", "ACTIVE")
        message = f"Incident acknowledged by {payload.actor}."
        if payload.note:
            message += f" {payload.note}"
        _incident_event(incident, "incident_acknowledged", payload.actor, message)
        _persist_incident(incident, required=False)
        return copy.deepcopy(incident)


@app.post("/v1/oncall/incidents/{incident_id}/investigate")
def investigate_oncall_incident(incident_id: str, payload: IncidentInvestigateRequest) -> dict[str, Any]:
    with _state_lock:
        incident = _incident_or_404(incident_id)
        if incident["status"] == "RESOLVED":
            raise HTTPException(status_code=409, detail="resolved incident cannot be investigated")
        if not incident["acknowledgedAt"]:
            incident["acknowledgedAt"] = utc_now()
        incident["owner"] = payload.actor
        incident["status"] = "INVESTIGATING"
        _set_runbook_step(incident, "ack", "DONE")
        _set_runbook_step(incident, "investigate", "DONE")
        _set_runbook_step(incident, "prepare", "ACTIVE")
        message = f"Live evidence correlated with {len(incident['similarIncidents'])} verified prior incident(s)."
        if payload.note:
            message += f" {payload.note}"
        _incident_event(incident, "investigation_completed", payload.actor, message)
        _persist_incident(incident, required=False)
        return copy.deepcopy(incident)


@app.post("/v1/oncall/incidents/{incident_id}/escalate")
def escalate_oncall_incident(incident_id: str, payload: IncidentEscalateRequest) -> dict[str, Any]:
    with _state_lock:
        incident = _incident_or_404(incident_id)
        if incident["status"] == "RESOLVED":
            raise HTTPException(status_code=409, detail="resolved incident cannot be escalated")
        escalation = {
            "id": f"ESC-{incident_id}-{len(incident['escalations']) + 1}",
            "actor": payload.actor, "target": payload.target, "reason": payload.reason,
            "createdAt": utc_now(), "resolvedAt": None,
        }
        incident["escalations"].append(escalation)
        incident["status"] = "ESCALATED"
        _incident_event(incident, "incident_escalated", payload.actor, f"Escalated to {payload.target}: {payload.reason}")
        _persist_incident(incident, required=False)
        return copy.deepcopy(incident)


@app.post("/v1/oncall/incidents/{incident_id}/timeline")
def add_oncall_timeline_event(incident_id: str, payload: IncidentTimelineRequest) -> dict[str, Any]:
    with _state_lock:
        incident = _incident_or_404(incident_id)
        _incident_event(incident, payload.eventType, payload.actor, payload.note)
        _persist_incident(incident, required=False)
        return copy.deepcopy(incident)


@app.post("/v1/oncall/incidents/{incident_id}/remediations/prepare")
def prepare_oncall_remediation(
    incident_id: str,
    payload: PrepareRemediationRequest,
    internal_token: str | None = Header(default=None, alias="X-RelayGrid-Internal-Token"),
) -> dict[str, Any]:
    if not _internal_action_allowed(internal_token):
        raise HTTPException(status_code=401, detail="invalid internal service credential")
    return _prepare_remediation_memory(incident_id, payload)


@app.post("/v1/oncall/incidents/{incident_id}/remediations/{intent_id}/execute")
def execute_oncall_remediation(
    incident_id: str,
    intent_id: str,
    payload: ExecuteRemediationRequest,
    internal_token: str | None = Header(default=None, alias="X-RelayGrid-Internal-Token"),
) -> dict[str, Any]:
    if not _internal_action_allowed(internal_token):
        raise HTTPException(status_code=401, detail="invalid internal service credential")
    return _execute_remediation(incident_id, intent_id, payload)


@app.post("/v1/oncall/incidents/{incident_id}/remediations/{intent_id}/reconcile")
def reconcile_oncall_remediation(
    incident_id: str,
    intent_id: str,
    internal_token: str | None = Header(default=None, alias="X-RelayGrid-Internal-Token"),
) -> dict[str, Any]:
    if not _internal_action_allowed(internal_token):
        raise HTTPException(status_code=401, detail="invalid internal service credential")
    return _reconcile_remediation(incident_id, intent_id)


@app.post("/v1/oncall/incidents/{incident_id}/resolve")
def resolve_oncall_incident(incident_id: str, payload: IncidentResolveRequest) -> dict[str, Any]:
    with _state_lock:
        incident = _incident_or_404(incident_id)
        if incident["status"] == "RESOLVED":
            return copy.deepcopy(incident)
        candidate = next(
            (
                item for item in reversed(incident["remediationIntents"])
                if item["state"] in ("APPLIED", "EXECUTING", "UNKNOWN")
            ),
            None,
        )
        if not candidate:
            raise HTTPException(
                status_code=409,
                detail="resolution requires a prepared remediation with attributable verification",
            )
        store = _authoritative_mutation_store()
        reconciliation = _reconcile_remediation(incident_id, candidate["id"])
        verification = reconciliation["verification"]
        if verification.get("state") != "APPLIED" or not verification.get("attributableProof"):
            raise HTTPException(status_code=409, detail="remediation is not currently attributable as APPLIED")
        current_evidence = verification.get("currentStateEvidence") or {}
        if current_evidence.get("matchesRequestedPostcondition") is not True:
            raise HTTPException(status_code=409, detail="remediation postcondition no longer holds in the authoritative store")
        if not _source_anomaly_resolved(store, incident):
            raise HTTPException(status_code=409, detail="source anomaly is still open; containment alone cannot resolve the incident")
        applied = next(item for item in incident["remediationIntents"] if item["id"] == candidate["id"])
        incident["status"] = "RESOLVED"
        incident["resolvedAt"] = utc_now()
        for escalation in incident["escalations"]:
            if not escalation.get("resolvedAt"):
                escalation["resolvedAt"] = incident["resolvedAt"]
        _set_runbook_step(incident, "verify", "DONE")
        _incident_event(incident, "incident_resolved", payload.actor, payload.resolutionNote)
        if applied and not any(item["incidentId"] == incident_id for item in _demo_state["incidentMemory"]):
            opened = datetime.fromisoformat(incident["createdAt"])
            resolved = datetime.fromisoformat(incident["resolvedAt"])
            duration = max(1, round((resolved - opened).total_seconds() / 60))
            _demo_state["incidentMemory"].append({
                "incidentId": incident_id,
                "fingerprint": incident["fingerprint"],
                "title": incident["title"],
                "resolution": payload.resolutionNote,
                "remediationAction": applied["action"],
                "durationMinutes": duration,
                "resolvedAt": incident["resolvedAt"],
                "verified": True,
                "evidenceSummary": applied["outcome"]["detail"],
            })
            same_fingerprint = [
                item for item in _demo_state["incidentMemory"]
                if item["fingerprint"] == incident["fingerprint"] and item.get("verified")
            ]
            if len(same_fingerprint) >= 3 and incident.get("suggestedPlaybook"):
                incident["suggestedPlaybook"]["status"] = "CONSOLIDATED"
                incident["suggestedPlaybook"]["sourceEpisodes"] = [
                    item["incidentId"] for item in same_fingerprint[-5:]
                ]
        _activity(_demo_state, "incident_resolved", f"{incident_id} resolved by {payload.actor}.")
        _persist_incident(incident, required=_authoritative_mutation_store() == "postgres")
        return copy.deepcopy(incident)


@app.post("/v1/recalls/impact")
def recall_impact(request: ImpactRequest) -> dict[str, Any]:
    if len(set(request.lotIds)) != len(request.lotIds):
        raise HTTPException(status_code=422, detail="lotIds must be unique")
    rows: list[Any] = []
    dsn = os.getenv("DATABASE_URL")
    if dsn:
        try:
            with psycopg.connect(dsn, connect_timeout=2) as connection:
                rows = connection.execute(
                    """SELECT l.lot_id, l.sku, l.product_name, l.quantity, l.status,
                              COUNT(o.order_id)::int AS affected_orders, COALESCE(SUM(o.quantity), 0)::int AS ordered_units
                       FROM inventory.lots l LEFT JOIN inventory.orders o ON o.lot_id = l.lot_id
                       WHERE l.lot_id = ANY(%s)
                       GROUP BY l.lot_id, l.sku, l.product_name, l.quantity, l.status ORDER BY l.lot_id""",
                    (request.lotIds,),
                ).fetchall()
        except psycopg.Error:
            rows = []
    if not rows:
        with _state_lock:
            lots = [lot for lot in _demo_state["lots"] if lot["lotId"] in request.lotIds]
        rows = [(lot["lotId"], lot["sku"], lot["productName"], lot["quantity"], lot["status"], 1, 2) for lot in lots]
    found = {row[0] for row in rows}
    missing = sorted(set(request.lotIds) - found)
    return {
        "recallId": request.recallId,
        "lots": [
            {"lotId": row[0], "sku": row[1], "productName": row[2], "onHandUnits": row[3],
             "status": row[4], "affectedOrders": row[5], "orderedUnits": row[6]}
            for row in rows
        ],
        "missingLotIds": missing,
        "requiresOperatorReview": bool(missing) or any(row[5] > 0 for row in rows),
    }


@app.get("/v1/warehouse/snapshot")
def get_warehouse_snapshot() -> dict[str, Any]:
    return warehouse_snapshot()


@app.get("/v1/warehouse/zones")
def get_zones() -> dict[str, Any]:
    snapshot = warehouse_snapshot()
    return {"warehouse": snapshot["warehouse"], "zones": snapshot["zones"]}


@app.get("/v1/warehouse/robots")
def get_robots() -> dict[str, Any]:
    snapshot = warehouse_snapshot()
    return {"robots": snapshot["robots"], "missions": snapshot["missions"]}


@app.get("/v1/warehouse/missions")
def get_missions() -> dict[str, Any]:
    return {"missions": warehouse_snapshot()["missions"]}


@app.get("/v1/warehouse/inventory")
def get_inventory() -> dict[str, Any]:
    return warehouse_snapshot()["inventory"]


@app.get("/v1/warehouse/anomalies")
def get_anomalies() -> dict[str, Any]:
    snapshot = warehouse_snapshot()
    return {"anomalies": snapshot["anomalies"], "activity": snapshot["activity"]}


@app.post("/v1/warehouse/demo/tick")
def tick_demo(payload: TickRequest) -> dict[str, Any]:
    try:
        return _tick_postgres(payload.steps)
    except (psycopg.Error, RuntimeError, KeyError, IndexError):
        return _tick_memory(payload.steps)


@app.post("/v1/warehouse/demo/toggle")
def toggle_demo(payload: ToggleRequest) -> dict[str, Any]:
    dsn = os.getenv("DATABASE_URL")
    if dsn:
        try:
            with psycopg.connect(dsn, connect_timeout=2, row_factory=dict_row) as connection:
                current = connection.execute("SELECT running FROM inventory.warehouse_sites WHERE site_id = %s FOR UPDATE", (WAREHOUSE_ID,)).fetchone()
                if not current:
                    raise RuntimeError("warehouse is not seeded")
                running = (not current["running"]) if payload.running is None else payload.running
                connection.execute("UPDATE inventory.warehouse_sites SET running = %s, mode = %s, updated_at = now() WHERE site_id = %s", (running, "demo" if running else "paused", WAREHOUSE_ID))
                connection.execute("INSERT INTO inventory.warehouse_activity(site_id, activity_type, message) VALUES (%s, 'simulation_state', %s)", (WAREHOUSE_ID, f"Digital twin {'resumed' if running else 'paused'} by operator."))
            return _postgres_snapshot()
        except (psycopg.Error, RuntimeError):
            pass
    return _toggle_memory(payload.running)


@app.post("/v1/warehouse/demo/orders")
def create_demo_order(payload: DemoOrderRequest) -> dict[str, Any]:
    try:
        return _create_order_postgres(payload)
    except (psycopg.Error, RuntimeError, KeyError, IndexError):
        return _create_order_memory(payload)


@app.post("/v1/warehouse/demo/anomalies")
def inject_demo_anomaly(payload: AnomalyRequest) -> dict[str, Any]:
    try:
        return _inject_anomaly_postgres(payload)
    except (psycopg.Error, RuntimeError, KeyError):
        return _inject_anomaly_memory(payload)


@app.post("/v1/warehouse/demo/reset")
def reset_demo() -> dict[str, Any]:
    try:
        return _reset_postgres()
    except (psycopg.Error, RuntimeError, KeyError):
        return _reset_memory()


@app.post("/v1/warehouse/robots/{robot_id}/actions")
def apply_robot_action(robot_id: str, payload: RobotActionRequest) -> dict[str, Any]:
    try:
        return _robot_action_postgres(robot_id, payload)
    except (psycopg.Error, RuntimeError, KeyError):
        return _robot_action_memory(robot_id, payload)
