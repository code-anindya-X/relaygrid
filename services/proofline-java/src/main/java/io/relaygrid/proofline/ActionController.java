package io.relaygrid.proofline;

import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

@RestController
@RequestMapping("/v1/actions")
public class ActionController {
    private static final Set<String> INCIDENT_REMEDIATIONS = Set.of(
        "pause_robot", "send_to_charging", "clear_robot_anomaly", "reroute_robot"
    );
    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;
    private final ActionAuditLog auditLog;

    public ActionController(JdbcTemplate jdbc, ObjectMapper objectMapper, ActionAuditLog auditLog) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.auditLog = auditLog;
    }

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("service", "proofline", "status", "ok");
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> createIntent(
            @RequestHeader("X-Proofline-Token") String serviceToken,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @RequestBody CreateAction request) {
        requireInternalToken(serviceToken);
        if (request == null || request.request() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "action request is required");
        }
        if (idempotencyKey.isBlank() || idempotencyKey.length() > 200) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid Idempotency-Key");
        }
        if (request.targetRef() == null || request.targetRef().isBlank() ||
            (!"quarantine_lot".equals(request.actionType()) && !"incident_remediation".equals(request.actionType()))) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "unsupported action or target");
        }
        if ("quarantine_lot".equals(request.actionType())) {
            if (!request.targetRef().equals(request.request().get("lotId")) ||
                request.request().get("recallId") == null || request.request().get("reason") == null) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "action target must match its recall request");
            }
        } else {
            Object incidentId = request.request().get("incidentId");
            Object robotId = request.request().get("robotId");
            Object remediation = request.request().get("action");
            String expectedTarget = String.valueOf(incidentId) + ":" + String.valueOf(robotId);
            if (incidentId == null || robotId == null || remediation == null ||
                !request.targetRef().equals(expectedTarget) ||
                !INCIDENT_REMEDIATIONS.contains(String.valueOf(remediation))) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "incident remediation target or action is invalid");
            }
            if ("reroute_robot".equals(String.valueOf(remediation)) && request.request().get("targetZoneId") == null) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "reroute remediation requires targetZoneId");
            }
        }

        UUID actionId = UUID.randomUUID();
        final String serializedRequest;
        try {
            serializedRequest = objectMapper.writeValueAsString(request.request());
        } catch (JacksonException exception) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid action request", exception);
        }
        int created = jdbc.update("""
            INSERT INTO proofline.action_intents
              (action_id, idempotency_key, action_type, target_ref, request, state)
            VALUES (?, ?, ?, ?, CAST(? AS jsonb), 'PENDING_APPROVAL')
            ON CONFLICT (idempotency_key) DO NOTHING
            """, actionId, idempotencyKey, request.actionType(), request.targetRef(), serializedRequest);

        if (created == 1) {
            auditLog.append(actionId, "INTENT_CREATED", "service:control-plane", Map.of(
                "actionType", request.actionType(),
                "targetRef", request.targetRef(),
                "idempotencyKey", idempotencyKey
            ));
        }

        return jdbc.queryForMap("""
            SELECT action_id, action_type, target_ref, state, created_at
            FROM proofline.action_intents WHERE idempotency_key = ?
            """, idempotencyKey);
    }

    @PostMapping("/{actionId}/approve")
    @Transactional
    public Map<String, Object> approve(@RequestHeader("X-Proofline-Token") String serviceToken,
                                       @PathVariable UUID actionId, @RequestBody Approval request) {
        requireInternalToken(serviceToken);
        if (request.approvedBy() == null || request.approvedBy().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "approvedBy is required");
        }
        int changed = jdbc.update("""
            UPDATE proofline.action_intents
            SET state = 'READY', approved_by = ?, approved_at = now(), updated_at = now()
            WHERE action_id = ? AND state = 'PENDING_APPROVAL'
            """, request.approvedBy(), actionId);
        if (changed == 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "action is missing or no longer awaiting approval");
        }
        auditLog.append(actionId, "APPROVED", request.approvedBy(), Map.of("source", "proofline-api"));
        return jdbc.queryForMap("SELECT action_id, state, approved_by, approved_at, updated_at FROM proofline.action_intents WHERE action_id = ?", actionId);
    }

    @PostMapping("/{actionId}/authorize")
    @Transactional
    public Map<String, Object> authorizeExecution(@RequestHeader("X-Proofline-Token") String serviceToken,
                                                   @PathVariable UUID actionId,
                                                   @RequestBody AuthorizeAction request) {
        requireInternalToken(serviceToken);
        if (request == null || request.approvedBy() == null || request.approvedBy().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "approval reference is required");
        }
        if (request.targetRef() == null || request.targetRef().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "approved target is required");
        }
        Map<String, Object> existing;
        try {
            existing = jdbc.queryForMap("SELECT action_id, action_type, target_ref, request, state FROM proofline.action_intents WHERE action_id = ?", actionId);
        } catch (org.springframework.dao.EmptyResultDataAccessException exception) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "action intent not found");
        }
        String actionType = String.valueOf(existing.get("action_type"));
        if ((!"quarantine_lot".equals(actionType) && !"incident_remediation".equals(actionType)) ||
            !request.targetRef().equals(existing.get("target_ref"))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "action does not match the approved target");
        }
        if ("EXECUTING".equals(existing.get("state"))) return existing;
        if (!"PENDING_APPROVAL".equals(existing.get("state")) && !"READY".equals(existing.get("state"))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "action is no longer awaiting approval");
        }
        if ("PENDING_APPROVAL".equals(existing.get("state"))) {
            int approved = jdbc.update("""
                UPDATE proofline.action_intents
                SET state = 'READY', approved_by = ?, approved_at = now(), updated_at = now()
                WHERE action_id = ? AND state = 'PENDING_APPROVAL'
                """, request.approvedBy(), actionId);
            if (approved == 0) throw new ResponseStatusException(HttpStatus.CONFLICT, "action approval changed concurrently");
            auditLog.append(actionId, "AUTHORIZED", request.approvedBy(), Map.of(
                "source", "operations-mcp",
                "targetRef", request.targetRef()
            ));
        }
        int changed = jdbc.update("""
            UPDATE proofline.action_intents
            SET state = 'EXECUTING', updated_at = now()
            WHERE action_id = ? AND state = 'READY'
            """, actionId);
        if (changed == 0) throw new ResponseStatusException(HttpStatus.CONFLICT, "action state changed concurrently");
        auditLog.append(actionId, "EXECUTION_CLAIMED", request.approvedBy(), Map.of(
            "source", "operations-mcp",
            "targetRef", request.targetRef()
        ));
        return jdbc.queryForMap("SELECT action_id, action_type, target_ref, request, state FROM proofline.action_intents WHERE action_id = ?", actionId);
    }

    @PostMapping("/{actionId}/outcome")
    @Transactional
    public Map<String, Object> recordOutcome(@RequestHeader("X-Proofline-Token") String serviceToken,
                                              @PathVariable UUID actionId,
                                              @RequestBody ActionOutcome outcome) {
        requireInternalToken(serviceToken);
        if (outcome == null || outcome.downstreamRef() == null || outcome.detailsJson() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "complete outcome is required");
        }
        if (!"APPLIED".equals(outcome.state()) && !"NOT_APPLIED".equals(outcome.state()) && !"UNKNOWN".equals(outcome.state())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid action outcome");
        }
        Map<String, Object> existing;
        try {
            existing = jdbc.queryForMap(
                "SELECT action_id, state, downstream_ref, outcome FROM proofline.action_intents WHERE action_id = ?",
                actionId
            );
        } catch (org.springframework.dao.EmptyResultDataAccessException exception) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "action intent not found");
        }
        if (outcome.state().equals(existing.get("state")) && outcome.downstreamRef().equals(existing.get("downstream_ref"))) {
            return existing;
        }
        int changed = jdbc.update("""
            UPDATE proofline.action_intents
            SET state = ?, downstream_ref = ?, outcome = CAST(? AS jsonb), updated_at = now()
            WHERE action_id = ? AND state IN ('EXECUTING', 'UNKNOWN')
            """, outcome.state(), outcome.downstreamRef(), outcome.detailsJson(), actionId);
        if (changed == 0) throw new ResponseStatusException(HttpStatus.CONFLICT, "action is not executing or reconcilable");
        auditLog.append(actionId, "OUTCOME_RECORDED", "service:operations-mcp", Map.of(
            "state", outcome.state(),
            "downstreamRef", outcome.downstreamRef()
        ));
        return jdbc.queryForMap("SELECT action_id, state, downstream_ref, outcome, updated_at FROM proofline.action_intents WHERE action_id = ?", actionId);
    }

    private void requireInternalToken(String supplied) {
        String expected = System.getenv("PROOFLINE_INTERNAL_TOKEN");
        if (supplied == null || expected == null || expected.isBlank() || !expected.equals(supplied)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "invalid service credential");
        }
    }

    public record CreateAction(String actionType, String targetRef, Map<String, Object> request) {}
    public record Approval(String approvedBy) {}
    public record AuthorizeAction(String approvedBy, String targetRef) {}
    public record ActionOutcome(String state, String downstreamRef, String detailsJson) {}
}
