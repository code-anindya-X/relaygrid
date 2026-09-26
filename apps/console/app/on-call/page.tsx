"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell, PageFooter } from "@/components/AppShell";
import type { OnCallActionName, OnCallIncident, OnCallSummary } from "@/lib/types";
import styles from "./on-call.module.css";

type QueuePayload = {
  items: OnCallIncident[];
  total: number;
  summary: OnCallSummary;
  source: string;
};

type OperatorSessionPayload = {
  authenticated: boolean;
  configured: boolean;
  operator?: string;
  role?: string;
  expiresAt?: string;
  error?: string;
};

const emptySummary: OnCallSummary = {
  total: 0,
  active: 0,
  critical: 0,
  unowned: 0,
  awaitingApproval: 0,
  resolved: 0,
  meanAcknowledgeMinutes: 0,
};

function humanize(value: string) {
  return value.replaceAll("_", " ").replaceAll("-", " ").toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function timeLabel(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function evidenceGlyph(kind: string) {
  return ({ signal: "⌁", metric: "↗", log: "≡", agent: "✦", operator: "◎", action: "→" } as Record<string, string>)[kind] || "·";
}

function initials(value: string) {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "OP";
}

export default function OnCallPage() {
  const [items, setItems] = useState<OnCallIncident[]>([]);
  const [summary, setSummary] = useState<OnCallSummary>(emptySummary);
  const [source, setSource] = useState("connecting");
  const [selected, setSelected] = useState<OnCallIncident | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState<OnCallActionName | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState("");
  const [status, setStatus] = useState("");
  const [owner, setOwner] = useState("");
  const [operatorSession, setOperatorSession] = useState<OperatorSessionPayload>({ authenticated: false, configured: true });
  const [sessionLoading, setSessionLoading] = useState(true);
  const [accessCode, setAccessCode] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [actionMode, setActionMode] = useState<"remediate" | "escalate" | "resolve" | null>(null);
  const [remediation, setRemediation] = useState({ summary: "", action: "pause_robot", targetZoneId: "ZONE-PACKING", scope: "", rollback: "", risk: "MEDIUM" });
  const [escalation, setEscalation] = useState({ target: "Site reliability lead", reason: "" });
  const [resolutionNote, setResolutionNote] = useState("");

  async function loadOperatorSession() {
    setSessionLoading(true);
    try {
      const response = await fetch("/api/operator-session", { cache: "no-store" });
      const payload = await response.json() as OperatorSessionPayload;
      setOperatorSession(payload);
    } catch {
      setOperatorSession({ authenticated: false, configured: false });
      setSessionError("Operator session service is unavailable");
    } finally {
      setSessionLoading(false);
    }
  }

  async function unlockOperator(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessCode || unlocking) return;
    setUnlocking(true);
    setSessionError(null);
    try {
      const response = await fetch("/api/operator-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessCode }),
      });
      const payload = await response.json() as OperatorSessionPayload;
      if (!response.ok) throw new Error(payload.error || "Operator unlock failed");
      setOperatorSession(payload);
      setAccessCode("");
      setFeedback(`Operator session unlocked for ${payload.operator}.`);
    } catch (unlockError) {
      setSessionError(unlockError instanceof Error ? unlockError.message : "Operator unlock failed");
    } finally {
      setUnlocking(false);
    }
  }

  async function lockOperator() {
    setSessionError(null);
    try {
      const response = await fetch("/api/operator-session", { method: "DELETE" });
      if (!response.ok) throw new Error("Could not lock the operator session");
      setOperatorSession({ authenticated: false, configured: true });
      setActionMode(null);
      setFeedback("Operator session locked. Incident reads remain available.");
    } catch (lockError) {
      setSessionError(lockError instanceof Error ? lockError.message : "Could not lock the operator session");
    }
  }

  async function loadQueue(preferredId?: string, quiet = false) {
    if (!quiet) setLoading(true);
    setError(null);
    const search = new URLSearchParams();
    if (query.trim()) search.set("q", query.trim());
    if (severity) search.set("severity", severity);
    if (status) search.set("status", status);
    if (owner) search.set("owner", owner);
    try {
      const response = await fetch(`/api/on-call/incidents${search.size ? `?${search}` : ""}`, { cache: "no-store" });
      const payload = await response.json() as QueuePayload & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Incident queue is unavailable");
      setItems(payload.items);
      setSummary(payload.summary || emptySummary);
      setSource(payload.source || "on-call-engine");
      const nextId = preferredId || selected?.id || payload.items[0]?.id;
      const next = payload.items.find((incident) => incident.id === nextId) || payload.items[0] || null;
      setSelected(next);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Incident queue is unavailable");
    } finally {
      setLoading(false);
    }
  }

  async function openIncident(incident: OnCallIncident) {
    setSelected(incident);
    setFeedback(null);
    setActionMode(null);
    try {
      const response = await fetch(`/api/on-call/incidents/${encodeURIComponent(incident.id)}`, { cache: "no-store" });
      const payload = await response.json() as { incident?: OnCallIncident };
      if (response.ok && payload.incident) setSelected(payload.incident);
    } catch {
      // The queue already carries a complete read model for offline operation.
    }
  }

  async function perform(action: OnCallActionName, body: Record<string, unknown> = {}) {
    if (!selected || mutating) return;
    if (!operatorSession.authenticated) {
      setSessionError("Unlock the operator session before changing incident state");
      return;
    }
    setMutating(action);
    setError(null);
    setFeedback(null);
    try {
      const response = await fetch(`/api/on-call/incidents/${encodeURIComponent(selected.id)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, expectedSource: source }),
      });
      const payload = await response.json() as { incident?: OnCallIncident; summary?: OnCallSummary; error?: string };
      if (!response.ok) {
        if (response.status === 401) {
          setOperatorSession({ authenticated: false, configured: true });
          setActionMode(null);
          setSessionError("Operator session expired. Unlock controls again.");
        }
        throw new Error(payload.error || `${humanize(action)} failed`);
      }
      const updatedIncident = payload.incident;
      if (updatedIncident) {
        setSelected(updatedIncident);
        setItems((current) => current.map((item) => item.id === updatedIncident.id ? updatedIncident : item));
      }
      if (payload.summary) setSummary(payload.summary);
      setFeedback(`${humanize(action)} recorded with a new evidence event.`);
      setActionMode(null);
      setEscalation((current) => ({ ...current, reason: "" }));
      setResolutionNote("");
      await loadQueue(selected.id, true);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `${humanize(action)} failed`);
    } finally {
      setMutating(null);
    }
  }

  useEffect(() => {
    void loadQueue();
    void loadOperatorSession();
  }, []);

  const sortedEvidence = useMemo(() => selected
    ? [...selected.evidence].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    : [], [selected]);
  const runbookProgress = selected
    ? (selected.runbook.steps.length ? Math.round(selected.runbook.steps.filter((step) => step.status === "complete").length / selected.runbook.steps.length * 100) : 0)
    : 0;
  const sourceEpisodeCount = selected?.suggestedPlaybook?.sourceEpisodes.length ?? 0;
  const canAct = operatorSession.authenticated && !sessionLoading;

  return (
    <AppShell section="Operations" title="On-call center" actions={<button className={styles.refreshButton} type="button" onClick={() => void loadQueue(selected?.id)} disabled={loading}><span>↻</span> Refresh</button>}>
      <div className={styles.page}>
        <section className={styles.hero}>
          <div>
            <span className={styles.eyebrow}><i /> LIVE RESPONSE · EVIDENCE FIRST</span>
            <h1>One calm surface for <em>every incident.</em></h1>
            <p>Agents gather evidence and prepare bounded actions. The on-call operator owns every decision, approval, escalation, and resolution.</p>
          </div>
          {operatorSession.authenticated && operatorSession.operator ? <div className={styles.dutyCard}>
            <span className={styles.dutyAvatar}>{initials(operatorSession.operator)}</span>
            <div><small>VERIFIED OPERATOR</small><strong>{operatorSession.operator}</strong><p>{humanize(operatorSession.role || "operator")} · signed session</p></div>
            <button className={styles.lockButton} type="button" onClick={() => void lockOperator()}>Lock</button>
          </div> : <form className={styles.unlockCard} onSubmit={unlockOperator}>
            <div><small>OPERATOR SESSION</small><strong>{sessionLoading ? "Checking session…" : "Unlock controls"}</strong><p>Incident evidence stays readable while controls are locked.</p></div>
            <div className={styles.unlockControls}>
              <input type="password" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} placeholder="Access code" autoComplete="current-password" aria-label="Operator access code" disabled={sessionLoading || !operatorSession.configured} />
              <button type="submit" disabled={sessionLoading || unlocking || !operatorSession.configured || !accessCode}>{unlocking ? "Unlocking…" : "Unlock"}</button>
            </div>
            {sessionError && <p className={styles.sessionError}>{sessionError}</p>}
            {!sessionLoading && !operatorSession.configured && <p className={styles.sessionError}>Operator access is not configured on the server.</p>}
          </form>}
        </section>

        <section className={styles.metrics} aria-label="Incident summary">
          <article className="glass-panel"><span className={styles.metricIcon}>⌁</span><div><small>ACTIVE INCIDENTS</small><strong>{summary.active}</strong><p>{summary.total} in current history</p></div></article>
          <article className="glass-panel"><span className={styles.metricIcon}>!</span><div><small>CRITICAL</small><strong>{summary.critical}</strong><p>SEV1 response in progress</p></div></article>
          <article className="glass-panel"><span className={styles.metricIcon}>◎</span><div><small>NEEDS AN OWNER</small><strong>{summary.unowned}</strong><p>Claim before action</p></div></article>
          <article className="glass-panel"><span className={styles.metricIcon}>✓</span><div><small>AWAITING APPROVAL</small><strong>{summary.awaitingApproval}</strong><p>Human checkpoints</p></div></article>
          <article className="glass-panel"><span className={styles.metricIcon}>◷</span><div><small>MEAN ACK</small><strong>{summary.meanAcknowledgeMinutes}m</strong><p>Across acknowledged events</p></div></article>
        </section>

        <div className={styles.workspaceTitle}>
          <div><small>INCIDENT COMMAND</small><h2>Active response workspace</h2></div>
          <span className={styles.source}><i /> {source === "console-demo" ? "RESILIENT LOCAL STATE" : "IMPACT ENGINE LIVE"}</span>
        </div>

        <section className={styles.workspace}>
          <aside className={`${styles.queue} glass-panel`}>
            <form className={styles.filters} onSubmit={(event) => { event.preventDefault(); void loadQueue(); }}>
              <label><span>SEARCH</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Incident, service, label…" /></label>
              <div>
                <select aria-label="Severity" value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="">All severity</option><option>SEV1</option><option>SEV2</option><option>SEV3</option><option>SEV4</option></select>
                <select aria-label="Status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All status</option><option value="OPEN">Open</option><option value="ACKNOWLEDGED">Acknowledged</option><option value="INVESTIGATING">Investigating</option><option value="AWAITING_APPROVAL">Awaiting approval</option><option value="REMEDIATING">Remediating</option><option value="ESCALATED">Escalated</option><option value="RESOLVED">Resolved</option></select>
              </div>
              <div>
                <select aria-label="Ownership" value={owner} onChange={(event) => setOwner(event.target.value)}><option value="">All ownership</option><option value="unowned">Unowned</option>{operatorSession.authenticated && operatorSession.operator && <option value={operatorSession.operator}>Mine</option>}</select>
                <button type="submit">Apply filters <span>→</span></button>
              </div>
            </form>
            <header className={styles.queueHeader}><span>INCIDENT QUEUE</span><small>{items.length} visible</small></header>
            <div className={styles.queueList}>
              {loading && [0, 1, 2, 3].map((item) => <div className={styles.skeleton} key={item} />)}
              {!loading && error && !items.length && <div className={styles.empty}><span>!</span><strong>Queue unavailable</strong><p>{error}</p><button type="button" onClick={() => void loadQueue()}>Try again</button></div>}
              {!loading && !error && !items.length && <div className={styles.empty}><span>✓</span><strong>No matching incidents</strong><p>Clear a filter to inspect incident history.</p></div>}
              {!loading && items.map((incident) => (
                <button type="button" key={incident.id} className={`${styles.queueItem} ${selected?.id === incident.id ? styles.selected : ""}`} onClick={() => void openIncident(incident)}>
                  <span className={styles.severity} data-severity={incident.severity}>{incident.severity}</span>
                  <span className={styles.queueCopy}><strong>{incident.title}</strong><small>{incident.service} · {incident.id}</small><em>{timeLabel(incident.updatedAt)} · {incident.owner || "Unowned"}</em></span>
                  <span className={styles.queueState} data-status={incident.status}>{humanize(incident.status)}</span>
                </button>
              ))}
            </div>
          </aside>

          <section className={`${styles.detail} glass-panel`} aria-live="polite">
            {!selected && <div className={styles.noSelection}><span>⌁</span><strong>Select an incident</strong><p>Open a queue item to inspect evidence, runbook state, and bounded actions.</p></div>}
            {selected && <>
              <header className={styles.incidentHeader}>
                <div className={styles.incidentIdentity}><div><span className={styles.severity} data-severity={selected.severity}>{selected.severity}</span><span className={styles.incidentId}>{selected.id}</span></div><h2>{selected.title}</h2><p>{selected.summary}</p></div>
                <div className={styles.incidentMeta}><span className={styles.largeStatus} data-status={selected.status}>{humanize(selected.status)}</span><small>UPDATED {timeLabel(selected.updatedAt).toUpperCase()}</small></div>
              </header>

              {feedback && <div className={styles.feedback}><span>✓</span><p>{feedback}</p><button type="button" onClick={() => setFeedback(null)}>×</button></div>}
              {error && items.length > 0 && <div className={`${styles.feedback} ${styles.error}`}><span>!</span><p>{error}</p><button type="button" onClick={() => setError(null)}>×</button></div>}

              <section className={styles.commandBar}>
                <div><small>OWNER</small><strong>{selected.owner || "Unassigned"}</strong><p>{selected.commander ? `Commander · ${selected.commander}` : "Claim to begin response"}</p></div>
                <div className={styles.operatorIdentity}><small>OPERATOR SESSION</small><strong>{operatorSession.operator || "Controls locked"}</strong><p>{operatorSession.authenticated ? humanize(operatorSession.role || "operator") : "Unlock above to act"}</p></div>
                <div className={styles.quickActions}>
                  {!selected.acknowledgedAt && selected.status !== "RESOLVED" && <button type="button" onClick={() => void perform("acknowledge")} disabled={!canAct || Boolean(mutating)}>{mutating === "acknowledge" ? "Acknowledging…" : "Acknowledge"}</button>}
                  {selected.status !== "RESOLVED" && <button type="button" onClick={() => void perform("investigate")} disabled={!canAct || Boolean(mutating)}>{mutating === "investigate" ? "Investigating…" : "Investigate"}</button>}
                </div>
              </section>

              <section className={styles.impactStrip}>
                <div><small>LIVE IMPACT</small><strong>{selected.impact.headline}</strong></div>
                <span><small>ORDERS AT RISK</small><b>{selected.impact.ordersAtRisk}</b></span>
                <span><small>ROBOTS</small><b>{selected.impact.robotsAffected}</b></span>
                <span><small>ZONES</small><b>{selected.impact.zonesAffected.length || "—"}</b></span>
              </section>

              <div className={styles.responseGrid}>
                <section className={styles.evidencePanel}>
                  <header><div><small>EVIDENCE TIMELINE</small><h3>What the system knows</h3></div><span>{sortedEvidence.length} events</span></header>
                  <ol>{sortedEvidence.map((event) => <li key={event.id}><span className={styles.evidenceGlyph} data-kind={event.kind}>{evidenceGlyph(event.kind)}</span><div><strong>{event.title}</strong><p>{event.detail}</p><small>{event.source} · {timeLabel(event.createdAt)}{typeof event.confidence === "number" ? ` · ${Math.round(event.confidence * 100)}% confidence` : ""}</small></div></li>)}</ol>
                  {selected.timeline && selected.timeline.length > 0 && <div className={styles.lifecycle}><span>LIFECYCLE TIMELINE</span>{[...selected.timeline].reverse().slice(0, 4).map((event) => <p key={event.id}><b>{humanize(event.type)}</b><em>{event.actor} · {timeLabel(event.createdAt)}</em><small>{event.message}</small></p>)}</div>}
                </section>

                <section className={styles.runbookPanel}>
                  <header><div><small>RUNBOOK PLAN · V{selected.runbook.version}</small><h3>{selected.runbook.name}</h3></div><span>{runbookProgress}%</span></header>
                  <div className={styles.progress}><i style={{ width: `${runbookProgress}%` }} /></div>
                  <ol>{selected.runbook.steps.map((step, index) => <li key={step.id} data-step={step.status}><span>{step.status === "complete" ? "✓" : index + 1}</span><div><strong>{step.title}{step.requiresApproval && <em>HUMAN GATE</em>}</strong><p>{step.description}</p></div></li>)}</ol>
                  {selected.suggestedPlaybook && <div className={styles.memoryCard}>
                    <span>{sourceEpisodeCount >= 3 ? "LEARNED PLAYBOOK" : "SUGGESTED PLAYBOOK"}</span>
                    <strong>{selected.suggestedPlaybook.name}</strong>
                    <p>{sourceEpisodeCount} verified source episode{sourceEpisodeCount === 1 ? "" : "s"} · {Math.round(selected.suggestedPlaybook.confidence * 100)}% confidence</p>
                    {selected.similarIncidents && <div>{selected.similarIncidents.slice(0, 3).map((item) => <em key={item.incidentId}>{item.incidentId} · {Math.round(item.similarity * 100)}%</em>)}</div>}
                  </div>}
                </section>
              </div>

              {selected.remediation && <section className={styles.proposal}>
                <div className={styles.proposalHeading}><span>BOUNDED REMEDIATION</span><strong>{selected.remediation.summary}</strong><p>{selected.remediation.action} · {selected.remediation.risk} RISK</p></div>
                <div><small>SCOPE</small><p>{selected.remediation.scope}</p></div>
                <div><small>ROLLBACK</small><p>{selected.remediation.rollback}</p></div>
                <span className={styles.proposalStatus}>{selected.remediation.status}</span>
                {selected.remediation.verification && <div className={styles.verification} data-outcome={selected.remediation.verification.state}><span>{selected.remediation.verification.state === "APPLIED" ? "✓" : selected.remediation.verification.state === "NOT_APPLIED" ? "×" : "?"}</span><div><small>VERIFIED OUTCOME · {selected.remediation.verification.state}</small><strong>{selected.remediation.verification.detail}</strong>{selected.remediation.verification.attributableProof && <p>Proof · {selected.remediation.verification.attributableProof}</p>}</div></div>}
              </section>}

              <section className={styles.actionCenter}>
                <div className={styles.actionIntro}><small>OPERATOR CONTROLS</small><h3>Move the incident forward</h3><p>Every control appends evidence. Physical remediation still passes through its approval gate.</p></div>
                {selected.status !== "RESOLVED" && <div className={styles.actionButtons}>
                  <button type="button" disabled={!canAct} onClick={() => setActionMode("remediate")}>Propose remediation</button>
                  {selected.remediation?.status === "PROPOSED" && <button className={styles.approveButton} type="button" disabled={!canAct || Boolean(mutating)} onClick={() => void perform("approve-remediation", { intentId: selected.remediation?.id, approvalNote: "Evidence and rollback reviewed in the on-call center." })}>{mutating === "approve-remediation" ? "Approving…" : "Approve bounded action"}</button>}
                  <button type="button" disabled={!canAct} onClick={() => setActionMode("escalate")}>Escalate</button>
                  {selected.remediation?.verification?.state === "APPLIED" && <button type="button" disabled={!canAct} onClick={() => setActionMode("resolve")}>Resolve</button>}
                </div>}
                {selected.status === "RESOLVED" && <div className={styles.resolvedNote}><span>✓</span><div><strong>Response complete</strong><p>Resolved {selected.resolvedAt ? timeLabel(selected.resolvedAt) : "with recorded evidence"} by {selected.owner || "the on-call team"}.</p></div></div>}

                {actionMode === "remediate" && <form className={styles.actionForm} onSubmit={(event) => { event.preventDefault(); void perform("propose-remediation", { ...remediation, rationale: remediation.summary }); }}>
                  <label><span>PLAN SUMMARY</span><input required value={remediation.summary} onChange={(event) => setRemediation({ ...remediation, summary: event.target.value })} placeholder="What safe outcome should this produce?" /></label>
                  <label><span>ACTION</span><select value={remediation.action} onChange={(event) => setRemediation({ ...remediation, action: event.target.value })}><option value="reroute_robot">Reroute robot</option><option value="pause_robot">Pause robot</option><option value="send_to_charging">Send to charging</option><option value="clear_robot_anomaly">Clear robot anomaly</option></select></label>
                  {remediation.action === "reroute_robot" && <label><span>TARGET ZONE</span><select value={remediation.targetZoneId} onChange={(event) => setRemediation({ ...remediation, targetZoneId: event.target.value })}><option value="ZONE-PACKING">Packing</option><option value="ZONE-CHARGING">Charging</option><option value="ZONE-RECEIVING">Receiving</option><option value="ZONE-RADIO">Radio systems</option><option value="ZONE-SMART">Smart home</option></select></label>}
                  <label><span>BOUNDED SCOPE</span><input required value={remediation.scope} onChange={(event) => setRemediation({ ...remediation, scope: event.target.value })} placeholder="Robot, zone, mission, or lot" /></label>
                  <label><span>ROLLBACK</span><input required value={remediation.rollback} onChange={(event) => setRemediation({ ...remediation, rollback: event.target.value })} placeholder="How the operator can reverse this" /></label>
                  <label><span>RISK</span><select value={remediation.risk} onChange={(event) => setRemediation({ ...remediation, risk: event.target.value })}><option>LOW</option><option>MEDIUM</option><option>HIGH</option></select></label>
                  <div><button type="button" onClick={() => setActionMode(null)}>Cancel</button><button type="submit" disabled={!canAct || Boolean(mutating)}>{mutating === "propose-remediation" ? "Preparing…" : "Prepare for approval"}</button></div>
                </form>}

                {actionMode === "escalate" && <form className={styles.actionForm} onSubmit={(event) => { event.preventDefault(); void perform("escalate", { ...escalation }); }}>
                  <label><span>ESCALATE TO</span><input required value={escalation.target} onChange={(event) => setEscalation({ ...escalation, target: event.target.value })} /></label>
                  <label className={styles.wideField}><span>REASON</span><textarea required rows={2} value={escalation.reason} onChange={(event) => setEscalation({ ...escalation, reason: event.target.value })} placeholder="What needs another responder or authority?" /></label>
                  <div><button type="button" onClick={() => setActionMode(null)}>Cancel</button><button type="submit" disabled={!canAct || Boolean(mutating)}>{mutating === "escalate" ? "Escalating…" : "Record escalation"}</button></div>
                </form>}

                {actionMode === "resolve" && selected.remediation?.verification?.state === "APPLIED" && <form className={styles.actionForm} onSubmit={(event) => { event.preventDefault(); void perform("resolve", { resolutionNote }); }}>
                  <label className={styles.wideField}><span>RESOLUTION EVIDENCE</span><textarea required rows={3} value={resolutionNote} onChange={(event) => setResolutionNote(event.target.value)} placeholder="What recovered, and how was it verified?" /></label>
                  <div><button type="button" onClick={() => setActionMode(null)}>Cancel</button><button type="submit" disabled={!canAct || Boolean(mutating)}>{mutating === "resolve" ? "Resolving…" : "Resolve with evidence"}</button></div>
                </form>}
              </section>
            </>}
          </section>
        </section>
        <PageFooter />
      </div>
    </AppShell>
  );
}
