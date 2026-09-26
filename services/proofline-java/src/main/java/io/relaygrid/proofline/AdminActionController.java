package io.relaygrid.proofline;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

@RestController
@RequestMapping("/v1/admin/actions")
public class AdminActionController {
    private static final Set<String> STATES = Set.of(
        "PENDING_APPROVAL", "READY", "EXECUTING", "APPLIED", "NOT_APPLIED", "UNKNOWN", "REJECTED"
    );

    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;
    private final ActionAuditLog auditLog;

    public AdminActionController(JdbcTemplate jdbc, ObjectMapper objectMapper, ActionAuditLog auditLog) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.auditLog = auditLog;
    }

    @GetMapping
    public Map<String, Object> list(
            @RequestHeader("X-Proofline-Token") String serviceToken,
            @RequestParam(required = false) String state,
            @RequestParam(required = false) String actionType,
            @RequestParam(required = false) String targetRef,
            @RequestParam(defaultValue = "50") int limit,
            @RequestParam(defaultValue = "0") int offset) {
        requireInternalToken(serviceToken);
        if (state != null && !STATES.contains(state)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid action state");
        }
        if (limit < 1 || limit > 100 || offset < 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "limit must be 1-100 and offset must be non-negative");
        }

        StringBuilder where = new StringBuilder(" WHERE 1=1");
        List<Object> parameters = new ArrayList<>();
        if (state != null) {
            where.append(" AND state = ?");
            parameters.add(state);
        }
        if (actionType != null && !actionType.isBlank()) {
            where.append(" AND action_type = ?");
            parameters.add(actionType);
        }
        if (targetRef != null && !targetRef.isBlank()) {
            where.append(" AND target_ref ILIKE ?");
            parameters.add("%" + targetRef.trim() + "%");
        }

        Long total = jdbc.queryForObject(
            "SELECT count(*) FROM proofline.action_intents" + where,
            Long.class,
            parameters.toArray()
        );
        List<Object> pageParameters = new ArrayList<>(parameters);
        pageParameters.add(limit);
        pageParameters.add(offset);
        List<Map<String, Object>> items = jdbc.query("""
            SELECT action_id, idempotency_key, action_type, target_ref, request::text AS request_json,
                   state, approved_by, approved_at, rejected_by, rejected_at, rejection_reason,
                   downstream_ref, outcome::text AS outcome_json, created_at, updated_at
            FROM proofline.action_intents
            """ + where + " ORDER BY created_at DESC, action_id DESC LIMIT ? OFFSET ?",
            (resultSet, rowNumber) -> mapAction(resultSet),
            pageParameters.toArray()
        );
        return Map.of("items", items, "total", total == null ? 0 : total, "limit", limit, "offset", offset);
    }

    @GetMapping("/summary")
    public Map<String, Object> summary(@RequestHeader("X-Proofline-Token") String serviceToken) {
        requireInternalToken(serviceToken);
        return jdbc.queryForObject("""
            SELECT count(*) AS total,
                   count(*) FILTER (WHERE state = 'PENDING_APPROVAL') AS pending_approval,
                   count(*) FILTER (WHERE state = 'READY') AS ready,
                   count(*) FILTER (WHERE state = 'APPLIED') AS applied,
                   count(*) FILTER (WHERE state = 'REJECTED') AS rejected,
                   count(*) FILTER (WHERE state IN ('NOT_APPLIED', 'UNKNOWN')) AS needs_attention,
                   count(*) FILTER (WHERE updated_at >= now() - interval '24 hours') AS updated_last_24_hours
            FROM proofline.action_intents
            """, (row, rowNumber) -> Map.of(
                "total", row.getLong("total"),
                "pendingApproval", row.getLong("pending_approval"),
                "ready", row.getLong("ready"),
                "applied", row.getLong("applied"),
                "rejected", row.getLong("rejected"),
                "needsAttention", row.getLong("needs_attention"),
                "updatedLast24Hours", row.getLong("updated_last_24_hours")
            ));
    }

    @GetMapping("/{actionId}")
    public Map<String, Object> detail(
            @RequestHeader("X-Proofline-Token") String serviceToken,
            @PathVariable UUID actionId) {
        requireInternalToken(serviceToken);
        Map<String, Object> action = findAction(actionId);
        return Map.of("action", action, "history", findHistory(actionId));
    }

    private List<Map<String, Object>> findHistory(UUID actionId) {
        return jdbc.query("""
            SELECT event_id, event_type, actor, details::text AS details_json, created_at
            FROM proofline.action_events
            WHERE action_id = ?
            ORDER BY created_at ASC, event_id ASC
            """, (resultSet, rowNumber) -> mapEvent(resultSet), actionId);
    }

    @PostMapping("/{actionId}/approve")
    @Transactional
    public Map<String, Object> approve(
            @RequestHeader("X-Proofline-Token") String serviceToken,
            @PathVariable UUID actionId,
            @RequestBody Review request) {
        requireInternalToken(serviceToken);
        requireActor(request);
        int changed = jdbc.update("""
            UPDATE proofline.action_intents
            SET state = 'READY', approved_by = ?, approved_at = now(),
                rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL, updated_at = now()
            WHERE action_id = ? AND state = 'PENDING_APPROVAL'
            """, request.actor().trim(), actionId);
        if (changed == 0) {
            throw reviewConflict(actionId);
        }
        auditLog.append(actionId, "APPROVED", request.actor().trim(), optionalNote(request.note()));
        return detailAfterMutation(actionId);
    }

    @PostMapping("/{actionId}/reject")
    @Transactional
    public Map<String, Object> reject(
            @RequestHeader("X-Proofline-Token") String serviceToken,
            @PathVariable UUID actionId,
            @RequestBody Review request) {
        requireInternalToken(serviceToken);
        requireActor(request);
        if (request.reason() == null || request.reason().isBlank() || request.reason().length() > 1000) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "rejection reason is required and must be at most 1000 characters");
        }
        int changed = jdbc.update("""
            UPDATE proofline.action_intents
            SET state = 'REJECTED', rejected_by = ?, rejected_at = now(),
                rejection_reason = ?, updated_at = now()
            WHERE action_id = ? AND state = 'PENDING_APPROVAL'
            """, request.actor().trim(), request.reason().trim(), actionId);
        if (changed == 0) {
            throw reviewConflict(actionId);
        }
        Map<String, Object> details = new LinkedHashMap<>(optionalNote(request.note()));
        details.put("reason", request.reason().trim());
        auditLog.append(actionId, "REJECTED", request.actor().trim(), details);
        return detailAfterMutation(actionId);
    }

    private Map<String, Object> detailAfterMutation(UUID actionId) {
        return Map.of("action", findAction(actionId), "history", findHistory(actionId));
    }

    private ResponseStatusException reviewConflict(UUID actionId) {
        Boolean present = jdbc.queryForObject(
            "SELECT EXISTS (SELECT 1 FROM proofline.action_intents WHERE action_id = ?)", Boolean.class, actionId
        );
        if (!Boolean.TRUE.equals(present)) {
            return new ResponseStatusException(HttpStatus.NOT_FOUND, "action intent not found");
        }
        return new ResponseStatusException(HttpStatus.CONFLICT, "action is no longer awaiting approval");
    }

    private Map<String, Object> findAction(UUID actionId) {
        try {
            return jdbc.queryForObject("""
                SELECT action_id, idempotency_key, action_type, target_ref, request::text AS request_json,
                       state, approved_by, approved_at, rejected_by, rejected_at, rejection_reason,
                       downstream_ref, outcome::text AS outcome_json, created_at, updated_at
                FROM proofline.action_intents WHERE action_id = ?
                """, (resultSet, rowNumber) -> mapAction(resultSet), actionId);
        } catch (EmptyResultDataAccessException exception) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "action intent not found");
        }
    }

    private Map<String, Object> mapAction(ResultSet row) throws SQLException {
        Map<String, Object> action = new LinkedHashMap<>();
        action.put("actionId", row.getObject("action_id", UUID.class));
        action.put("idempotencyKey", row.getString("idempotency_key"));
        action.put("actionType", row.getString("action_type"));
        action.put("targetRef", row.getString("target_ref"));
        action.put("request", parseJson(row.getString("request_json")));
        action.put("state", row.getString("state"));
        putNullable(action, "approvedBy", row.getString("approved_by"));
        putNullable(action, "approvedAt", row.getObject("approved_at", OffsetDateTime.class));
        putNullable(action, "rejectedBy", row.getString("rejected_by"));
        putNullable(action, "rejectedAt", row.getObject("rejected_at", OffsetDateTime.class));
        putNullable(action, "rejectionReason", row.getString("rejection_reason"));
        putNullable(action, "downstreamRef", row.getString("downstream_ref"));
        String outcome = row.getString("outcome_json");
        if (outcome != null) action.put("outcome", parseJson(outcome));
        action.put("createdAt", row.getObject("created_at", OffsetDateTime.class));
        action.put("updatedAt", row.getObject("updated_at", OffsetDateTime.class));
        return action;
    }

    private Map<String, Object> mapEvent(ResultSet row) throws SQLException {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("eventId", row.getLong("event_id"));
        event.put("eventType", row.getString("event_type"));
        event.put("actor", row.getString("actor"));
        event.put("details", parseJson(row.getString("details_json")));
        event.put("createdAt", row.getObject("created_at", OffsetDateTime.class));
        return event;
    }

    private Object parseJson(String value) {
        try {
            return objectMapper.readValue(value, Object.class);
        } catch (JacksonException exception) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "stored action data is invalid", exception);
        }
    }

    private void requireActor(Review request) {
        if (request == null || request.actor() == null || request.actor().isBlank() || request.actor().length() > 200) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "actor is required and must be at most 200 characters");
        }
    }

    private Map<String, Object> optionalNote(String note) {
        if (note == null || note.isBlank()) return Map.of();
        if (note.length() > 1000) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "note must be at most 1000 characters");
        }
        return Map.of("note", note.trim());
    }

    private void putNullable(Map<String, Object> target, String key, Object value) {
        if (value != null) target.put(key, value);
    }

    private void requireInternalToken(String supplied) {
        String expected = System.getenv("PROOFLINE_INTERNAL_TOKEN");
        if (supplied == null || expected == null || expected.isBlank() || !expected.equals(supplied)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "invalid service credential");
        }
    }

    public record Review(String actor, String reason, String note) {}
}
