CREATE SCHEMA IF NOT EXISTS inventory;
CREATE SCHEMA IF NOT EXISTS proofline;

CREATE TABLE IF NOT EXISTS inventory.lots (
    lot_id text PRIMARY KEY,
    sku text NOT NULL,
    product_name text NOT NULL,
    quantity integer NOT NULL CHECK (quantity >= 0),
    status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'quarantined', 'depleted')),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory.orders (
    order_id text PRIMARY KEY,
    lot_id text NOT NULL REFERENCES inventory.lots(lot_id),
    quantity integer NOT NULL CHECK (quantity > 0),
    status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proofline.action_intents (
    action_id uuid PRIMARY KEY,
    idempotency_key text NOT NULL UNIQUE,
    action_type text NOT NULL,
    target_ref text NOT NULL,
    request jsonb NOT NULL,
    state text NOT NULL CHECK (state IN ('PENDING_APPROVAL', 'READY', 'EXECUTING', 'APPLIED', 'NOT_APPLIED', 'UNKNOWN', 'REJECTED')),
    approved_by text,
    approved_at timestamptz,
    rejected_by text,
    rejected_at timestamptz,
    rejection_reason text,
    downstream_ref text,
    outcome jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS action_intents_state_updated_idx ON proofline.action_intents(state, updated_at);

-- These ALTER statements make this file safe to re-run against databases that
-- were created before admin review and rejection metadata was introduced.
ALTER TABLE proofline.action_intents ADD COLUMN IF NOT EXISTS rejected_by text;
ALTER TABLE proofline.action_intents ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
ALTER TABLE proofline.action_intents ADD COLUMN IF NOT EXISTS rejection_reason text;

CREATE TABLE IF NOT EXISTS proofline.action_events (
    event_id bigserial PRIMARY KEY,
    action_id uuid NOT NULL REFERENCES proofline.action_intents(action_id) ON DELETE CASCADE,
    event_type text NOT NULL,
    actor text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS action_events_action_created_idx
    ON proofline.action_events(action_id, created_at, event_id);

INSERT INTO proofline.action_events (action_id, event_type, actor, details, created_at)
SELECT action_id, 'INTENT_IMPORTED', 'system:migration',
       jsonb_build_object('stateAtImport', state), created_at
FROM proofline.action_intents intent
WHERE NOT EXISTS (
    SELECT 1 FROM proofline.action_events event WHERE event.action_id = intent.action_id
);

-- Digital-twin state. Coordinates use the same 60x40 floor grid rendered by the
-- operator console. The simulator remains deterministic; these tables simply
-- make its state durable when PostgreSQL is available.
CREATE TABLE IF NOT EXISTS inventory.warehouse_sites (
    site_id text PRIMARY KEY,
    name text NOT NULL,
    width integer NOT NULL CHECK (width > 0),
    depth integer NOT NULL CHECK (depth > 0),
    running boolean NOT NULL DEFAULT true,
    mode text NOT NULL DEFAULT 'demo' CHECK (mode IN ('demo', 'live', 'paused')),
    simulation_tick integer NOT NULL DEFAULT 0 CHECK (simulation_tick >= 0),
    orders_today integer NOT NULL DEFAULT 0 CHECK (orders_today >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory.warehouse_zones (
    zone_id text PRIMARY KEY,
    site_id text NOT NULL REFERENCES inventory.warehouse_sites(site_id) ON DELETE CASCADE,
    name text NOT NULL,
    zone_type text NOT NULL,
    x integer NOT NULL,
    y integer NOT NULL,
    width integer NOT NULL CHECK (width > 0),
    depth integer NOT NULL CHECK (depth > 0),
    color text NOT NULL,
    inventory_units integer NOT NULL DEFAULT 0 CHECK (inventory_units >= 0)
);

CREATE TABLE IF NOT EXISTS inventory.agv_robots (
    robot_id text PRIMARY KEY,
    site_id text NOT NULL REFERENCES inventory.warehouse_sites(site_id) ON DELETE CASCADE,
    name text NOT NULL,
    x integer NOT NULL,
    y integer NOT NULL,
    heading integer NOT NULL DEFAULT 0 CHECK (heading >= 0 AND heading < 360),
    battery integer NOT NULL CHECK (battery >= 0 AND battery <= 100),
    state text NOT NULL CHECK (state IN ('ready', 'executing', 'paused', 'charging', 'blocked', 'offline')),
    current_mission_id text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory.robot_missions (
    mission_id text PRIMARY KEY,
    site_id text NOT NULL REFERENCES inventory.warehouse_sites(site_id) ON DELETE CASCADE,
    order_ref text NOT NULL,
    robot_id text REFERENCES inventory.agv_robots(robot_id) ON DELETE SET NULL,
    status text NOT NULL CHECK (status IN ('queued', 'active', 'paused', 'completed', 'cancelled')),
    stage text NOT NULL,
    progress integer NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
    route jsonb NOT NULL DEFAULT '[]'::jsonb,
    priority integer NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory.warehouse_anomalies (
    anomaly_id text PRIMARY KEY,
    site_id text NOT NULL REFERENCES inventory.warehouse_sites(site_id) ON DELETE CASCADE,
    severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    anomaly_type text NOT NULL,
    message text NOT NULL,
    robot_id text REFERENCES inventory.agv_robots(robot_id) ON DELETE SET NULL,
    resolved boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS inventory.warehouse_activity (
    activity_id bigserial PRIMARY KEY,
    site_id text NOT NULL REFERENCES inventory.warehouse_sites(site_id) ON DELETE CASCADE,
    activity_type text NOT NULL,
    message text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inventory.lots ADD COLUMN IF NOT EXISTS zone_id text REFERENCES inventory.warehouse_zones(zone_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS robot_missions_site_status_idx ON inventory.robot_missions(site_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS warehouse_anomalies_open_idx ON inventory.warehouse_anomalies(site_id, resolved, created_at DESC);
CREATE INDEX IF NOT EXISTS warehouse_activity_site_created_idx ON inventory.warehouse_activity(site_id, created_at DESC);

-- On-call incident snapshots keep Proofline action ids connected to their
-- incident after an impact-engine restart. Robot mutations carry a receipt in
-- the same PostgreSQL transaction, keyed by the Proofline action intent id.
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
