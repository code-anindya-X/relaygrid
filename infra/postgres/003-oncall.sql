CREATE TABLE IF NOT EXISTS inventory.oncall_incidents (
    incident_id text PRIMARY KEY,
    anomaly_id text,
    fingerprint text NOT NULL,
    status text NOT NULL,
    snapshot jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oncall_incidents_status_updated_idx
    ON inventory.oncall_incidents(status, updated_at DESC);

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
);

CREATE INDEX IF NOT EXISTS remediation_receipts_incident_idx
    ON inventory.remediation_receipts(incident_id, applied_at DESC);
