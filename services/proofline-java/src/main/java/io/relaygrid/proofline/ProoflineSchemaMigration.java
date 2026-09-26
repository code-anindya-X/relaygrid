package io.relaygrid.proofline;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Applies the small, idempotent Proofline admin upgrade on startup. The same
 * statements also live in infra/postgres for clean database creation; running
 * them here upgrades an existing local volume without requiring data deletion.
 */
@Component
public class ProoflineSchemaMigration implements ApplicationRunner {
    private final JdbcTemplate jdbc;

    public ProoflineSchemaMigration(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        jdbc.execute("ALTER TABLE proofline.action_intents ADD COLUMN IF NOT EXISTS rejected_by text");
        jdbc.execute("ALTER TABLE proofline.action_intents ADD COLUMN IF NOT EXISTS rejected_at timestamptz");
        jdbc.execute("ALTER TABLE proofline.action_intents ADD COLUMN IF NOT EXISTS rejection_reason text");
        jdbc.execute("""
            CREATE TABLE IF NOT EXISTS proofline.action_events (
                event_id bigserial PRIMARY KEY,
                action_id uuid NOT NULL REFERENCES proofline.action_intents(action_id) ON DELETE CASCADE,
                event_type text NOT NULL,
                actor text NOT NULL,
                details jsonb NOT NULL DEFAULT '{}'::jsonb,
                created_at timestamptz NOT NULL DEFAULT now()
            )
            """);
        jdbc.execute("""
            CREATE INDEX IF NOT EXISTS action_events_action_created_idx
            ON proofline.action_events(action_id, created_at, event_id)
            """);
        jdbc.update("""
            INSERT INTO proofline.action_events (action_id, event_type, actor, details, created_at)
            SELECT action_id, 'INTENT_IMPORTED', 'system:migration',
                   jsonb_build_object('stateAtImport', state), created_at
            FROM proofline.action_intents intent
            WHERE NOT EXISTS (
                SELECT 1 FROM proofline.action_events event WHERE event.action_id = intent.action_id
            )
            """);
    }
}
