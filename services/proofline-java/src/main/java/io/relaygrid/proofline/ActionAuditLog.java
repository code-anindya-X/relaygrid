package io.relaygrid.proofline;

import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

@Component
public class ActionAuditLog {
    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;

    public ActionAuditLog(JdbcTemplate jdbc, ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    public void append(UUID actionId, String eventType, String actor, Map<String, ?> details) {
        try {
            jdbc.update("""
                INSERT INTO proofline.action_events (action_id, event_type, actor, details)
                VALUES (?, ?, ?, CAST(? AS jsonb))
                """, actionId, eventType, actor, objectMapper.writeValueAsString(details));
        } catch (JacksonException exception) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "could not serialize audit event", exception);
        }
    }
}
