-- Idempotent upgrade for an existing RelayGrid database.
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
