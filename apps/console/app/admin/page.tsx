"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { AppShell, PageFooter } from "@/components/AppShell";
import type { ProoflineAction } from "@/lib/types";
import styles from "./admin.module.css";

type AdminAction = {
  actionId: string;
  idempotencyKey: string;
  actionType: string;
  targetRef: string;
  request: ProoflineAction["request"];
  state: string;
  approvedBy?: string | null;
  approvedAt?: string | null;
  rejectedBy?: string | null;
  rejectedAt?: string | null;
  rejectionReason?: string | null;
  downstreamRef?: string | null;
  outcome?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

type AuditEvent = {
  eventId: number;
  eventType: string;
  actor: string;
  details: Record<string, unknown>;
  createdAt: string;
};

type Summary = {
  total: number;
  pendingApproval: number;
  ready: number;
  applied: number;
  rejected: number;
  needsAttention: number;
  updatedLast24Hours: number;
  source?: string;
};

type Detail = { action: AdminAction; history: AuditEvent[]; source?: string };

const stateOptions = [
  ["", "All states"],
  ["PENDING_APPROVAL", "Awaiting review"],
  ["READY", "Approved / ready"],
  ["APPLIED", "Applied"],
  ["REJECTED", "Rejected"],
  ["UNKNOWN", "Needs attention"],
];

function humanize(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function formatTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

function detailValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

async function apiJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { ...init, headers: { "content-type": "application/json", ...init?.headers }, cache: "no-store" });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload as T;
}

export default function AdminPage() {
  const [actions, setActions] = useState<AdminAction[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [stateFilter, setStateFilter] = useState("PENDING_APPROVAL");
  const [typeFilter, setTypeFilter] = useState("");
  const [targetFilter, setTargetFilter] = useState("");
  const [actor, setActor] = useState("alex@northstar.local");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mutating, setMutating] = useState<"approve" | "reject" | "">("");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState<{ tone: "success" | "danger"; message: string } | null>(null);
  const [source, setSource] = useState("proofline");

  const loadQueue = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ limit: "50" });
    if (stateFilter) query.set("state", stateFilter);
    if (typeFilter.trim()) query.set("actionType", typeFilter.trim());
    if (targetFilter.trim()) query.set("targetRef", targetFilter.trim());
    try {
      const [list, totals] = await Promise.all([
        apiJson<{ items: AdminAction[]; source?: string }>(`/api/admin/actions?${query}`),
        apiJson<Summary>("/api/admin/actions/summary"),
      ]);
      setActions(list.items);
      setSummary(totals);
      setSource(list.source || totals.source || "proofline");
      setSelectedId((current) => list.items.some((item) => item.actionId === current) ? current : (list.items[0]?.actionId || ""));
      if (!list.items.length) setDetail(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Approval queue could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [stateFilter, targetFilter, typeFilter]);

  useEffect(() => { void loadQueue(); }, [loadQueue]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setDetailLoading(true);
    apiJson<Detail>(`/api/admin/actions/${selectedId}`)
      .then((payload) => { if (active) { setDetail(payload); setSource(payload.source || "proofline"); } })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Action details could not be loaded"); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [selectedId]);

  const selected = detail?.action;
  const pending = selected?.state === "PENDING_APPROVAL";
  const requestEntries = useMemo(() => Object.entries(selected?.request || {}), [selected]);

  async function decide(decision: "approve" | "reject") {
    if (!selected || !pending || mutating) return;
    if (!actor.trim()) {
      setFeedback({ tone: "danger", message: "Add the reviewer identity before recording a decision." });
      return;
    }
    if (decision === "reject" && !reason.trim()) {
      setFeedback({ tone: "danger", message: "A rejection reason is required for the audit record." });
      return;
    }
    setMutating(decision);
    setFeedback(null);
    try {
      const updated = await apiJson<Detail>(`/api/admin/actions/${selected.actionId}/${decision}`, {
        method: "POST",
        body: JSON.stringify({ actor: actor.trim(), note: note.trim() || undefined, reason: reason.trim() || undefined }),
      });
      setDetail(updated);
      setSource(updated.source || "proofline");
      setFeedback({
        tone: "success",
        message: decision === "approve"
          ? `${selected.targetRef} is approved and ready for bounded execution.`
          : `${selected.targetRef} was rejected and will not be executed.`,
      });
      setNote("");
      setReason("");
      setActions((current) => {
        if (stateFilter && updated.action.state !== stateFilter) {
          return current.filter((item) => item.actionId !== updated.action.actionId);
        }
        return current.map((item) => item.actionId === updated.action.actionId ? updated.action : item);
      });
      try {
        const totals = await apiJson<Summary>("/api/admin/actions/summary");
        setSummary(totals);
      } catch {
        // The recorded decision remains visible even if the summary refresh fails.
      }
    } catch (cause) {
      setFeedback({ tone: "danger", message: cause instanceof Error ? cause.message : "Decision could not be recorded" });
    } finally {
      setMutating("");
    }
  }

  const headerActions = <button className={styles.headerRefresh} type="button" onClick={() => void loadQueue()} disabled={loading}><span>↻</span>{loading ? "Syncing" : "Sync queue"}</button>;

  return (
    <AppShell section="Governance" title="Approvals" actions={headerActions}>
      <div className={styles.page}>
        <section className={styles.hero}>
          <div>
            <div className={styles.eyebrow}><i /> PROOFLINE CONTROL DESK</div>
            <h1>Review every action<br /><em>before it reaches the floor.</em></h1>
            <p>Inspect agent intent, scope, and audit evidence. One human decision unlocks exactly one bounded operation.</p>
          </div>
          <div className={styles.heroSeal} aria-hidden="true"><span>✓</span><i /><b /></div>
        </section>

        <section className={styles.metrics} aria-label="Proofline summary">
          <article className={`${styles.metric} glass-panel`}><span className={styles.metricIcon}>Ⅱ</span><div><small>AWAITING REVIEW</small><strong>{summary?.pendingApproval ?? "—"}</strong><p>Human decision required</p></div></article>
          <article className={`${styles.metric} glass-panel`}><span className={styles.metricIcon}>✓</span><div><small>READY TO EXECUTE</small><strong>{summary?.ready ?? "—"}</strong><p>Approved, still bounded</p></div></article>
          <article className={`${styles.metric} glass-panel`}><span className={styles.metricIcon}>↗</span><div><small>APPLIED</small><strong>{summary?.applied ?? "—"}</strong><p>Verified outcomes</p></div></article>
          <article className={`${styles.metric} glass-panel ${summary?.needsAttention ? styles.attention : ""}`}><span className={styles.metricIcon}>!</span><div><small>NEEDS ATTENTION</small><strong>{summary?.needsAttention ?? "—"}</strong><p>Unknown or incomplete</p></div></article>
        </section>

        <div className={styles.workspaceHeading}>
          <div><span>OPERATOR WORKSPACE</span><h2>Action approval queue</h2></div>
          <span className={styles.sourcePill}><i /> {source === "console-demo" ? "DEMO LEDGER" : "LIVE PROOFLINE"}</span>
        </div>

        <section className={styles.workspace}>
          <aside className={`${styles.queue} glass-panel`}>
            <form className={styles.filters} onSubmit={loadQueue}>
              <label><span>STATE</span><select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>{stateOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <div className={styles.filterRow}>
                <label><span>ACTION TYPE</span><input value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} placeholder="quarantine_lot" /></label>
                <label><span>TARGET</span><input value={targetFilter} onChange={(event) => setTargetFilter(event.target.value)} placeholder="LOT-0001" /></label>
              </div>
              <button type="submit" disabled={loading}>Apply filters <span>→</span></button>
            </form>

            <div className={styles.queueTitle}><span>{loading ? "SYNCING QUEUE" : `${actions.length} ACTION${actions.length === 1 ? "" : "S"}`}</span><small>Newest first</small></div>
            <div className={styles.queueList}>
              {error && <div className={styles.loadError}><strong>Queue unavailable</strong><span>{error}</span><button type="button" onClick={() => void loadQueue()}>Try again</button></div>}
              {!error && !loading && actions.length === 0 && <div className={styles.empty}><span>✓</span><strong>Queue is clear</strong><p>No actions match these filters.</p></div>}
              {!error && loading && [0, 1, 2].map((item) => <div className={styles.skeleton} key={item} />)}
              {!loading && actions.map((action) => (
                <button type="button" className={`${styles.queueItem} ${selectedId === action.actionId ? styles.selected : ""}`} key={action.actionId} onClick={() => { setSelectedId(action.actionId); setFeedback(null); }}>
                  <span className={`${styles.stateDot} ${styles[action.state.toLowerCase()] || ""}`} />
                  <span className={styles.queueCopy}><strong>{humanize(action.actionType)}</strong><small>{action.targetRef}</small><em>{formatTime(action.createdAt)}</em></span>
                  <span className={styles.itemArrow}>›</span>
                </button>
              ))}
            </div>
          </aside>

          <section className={`${styles.review} glass-panel`} aria-live="polite">
            {!selectedId && <div className={styles.noSelection}><span>⌁</span><strong>Select an action</strong><p>Choose an intent from the queue to inspect its evidence and decision history.</p></div>}
            {selectedId && detailLoading && <div className={styles.noSelection}><span className={styles.spinner}>↻</span><strong>Opening action</strong><p>Reading intent and audit history from Proofline.</p></div>}
            {selected && !detailLoading && <>
              <header className={styles.reviewHeader}>
                <div><span className={styles.reviewKicker}>ACTION INTENT</span><h2>{humanize(selected.actionType)}</h2><p className={styles.actionId}>{selected.actionId}</p></div>
                <span className={`${styles.status} ${styles[selected.state.toLowerCase()] || ""}`}>{humanize(selected.state)}</span>
              </header>

              {feedback && <div className={`${styles.feedback} ${feedback.tone === "danger" ? styles.feedbackDanger : ""}`}><span>{feedback.tone === "success" ? "✓" : "!"}</span><p>{feedback.message}</p><button type="button" onClick={() => setFeedback(null)} aria-label="Dismiss feedback">×</button></div>}

              <div className={styles.scopeBanner}>
                <span className={styles.scopeIcon}>⌖</span>
                <div><small>BOUNDED TARGET</small><strong>{selected.targetRef}</strong><p>Approval applies only to this target and action ID.</p></div>
                <span className={styles.scopeLock}>LOCKED SCOPE</span>
              </div>

              <div className={styles.detailGrid}>
                <section className={styles.intentCard}>
                  <div className={styles.sectionTitle}><span>REQUEST EVIDENCE</span><small>{requestEntries.length} fields</small></div>
                  <dl>{requestEntries.map(([key, value]) => <div key={key}><dt>{humanize(key)}</dt><dd>{detailValue(value)}</dd></div>)}</dl>
                  <div className={styles.integrityRow}><span><small>CREATED</small><strong>{formatTime(selected.createdAt)}</strong></span><span><small>IDEMPOTENCY KEY</small><strong>{selected.idempotencyKey}</strong></span></div>
                </section>

                <section className={styles.auditCard}>
                  <div className={styles.sectionTitle}><span>AUDIT TRAIL</span><small>{detail.history.length} events</small></div>
                  <ol className={styles.timeline}>{detail.history.map((event, index) => <li key={event.eventId}><span className={styles.timelineMark}>{index === detail.history.length - 1 ? "●" : "○"}</span><div><strong>{humanize(event.eventType)}</strong><p>{event.actor}</p><small>{formatTime(event.createdAt)}</small>{Object.keys(event.details || {}).length > 0 && <em>{Object.entries(event.details).map(([key, value]) => `${humanize(key)}: ${detailValue(value)}`).join(" · ")}</em>}</div></li>)}</ol>
                </section>
              </div>

              <section className={styles.decision}>
                <div className={styles.decisionIntro}><span>HUMAN CHECKPOINT</span><h3>{pending ? "Record an operator decision" : "Decision recorded"}</h3><p>{pending ? "Confirm the evidence and leave a trace for the next operator." : `This intent is ${humanize(selected.state).toLowerCase()} and can no longer be reviewed.`}</p></div>
                {pending && <div className={styles.decisionForm}>
                  <label><span>REVIEWER IDENTITY</span><input value={actor} onChange={(event) => setActor(event.target.value)} maxLength={200} /></label>
                  <label><span>OPERATOR NOTE <i>OPTIONAL</i></span><input value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} placeholder="Why this decision is safe" /></label>
                  <label className={styles.reasonField}><span>REJECTION REASON <i>REQUIRED TO REJECT</i></span><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={2} placeholder="What evidence is missing or unsafe?" /></label>
                  <div className={styles.decisionButtons}>
                    <button className={styles.rejectButton} type="button" onClick={() => void decide("reject")} disabled={Boolean(mutating)}>{mutating === "reject" ? "Recording…" : "Reject action"}</button>
                    <button className={styles.approveButton} type="button" onClick={() => void decide("approve")} disabled={Boolean(mutating)}>{mutating === "approve" ? "Recording…" : "Approve bounded action"}<span>→</span></button>
                  </div>
                </div>}
              </section>
            </>}
          </section>
        </section>
        <PageFooter />
      </div>
    </AppShell>
  );
}
