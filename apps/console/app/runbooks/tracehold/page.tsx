"use client";

import Link from "next/link";
import { useState } from "react";
import type { FormEvent } from "react";
import { AppShell, PageFooter } from "@/components/AppShell";

type RecallResult = {
  recallId: string;
  phase: string;
  source?: string;
  runbook: { name: string; version: number };
  impact: { lots: Array<{ lotId: string; sku: string; productName: string; onHandUnits: number; status: string; affectedOrders: number; orderedUnits: number }>; missingLotIds: string[]; requiresOperatorReview: boolean };
  actionPreviews: Array<{ action_id: string; action_type: string; target_ref: string; state: string }>;
  nextStep: string;
};

export default function TraceHoldPage() {
  const [result, setResult] = useState<RecallResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setResult(null);
    const form = new FormData(event.currentTarget);
    const payload = { recallId: String(form.get("recallId") ?? "").trim(), supplier: String(form.get("supplier") ?? "").trim(), lotIds: String(form.get("lotIds") ?? "").split(",").map((id) => id.trim()).filter(Boolean), reason: String(form.get("reason") ?? "").trim() };
    try {
      const response = await fetch("/api/tracehold", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
      setResult(data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to start recall review"); }
    finally { setBusy(false); }
  }

  return <AppShell section="Runbooks" title="TraceHold"><div className="content-wrap tracehold-page">
    <div className="hero-row"><div><div className="eyebrow"><span className="eyebrow-dot"/> RECALL RESPONSE <span className="eyebrow-separator">·</span> RUNBOOK 04</div><h1>Contain a recall.<br/><em>Know the impact first.</em></h1><p className="hero-copy">Trace affected inventory and orders, prepare durable action intents, then stop before quarantine for human approval.</p></div><div className="hero-orbit" aria-hidden="true"><span className="orbit-ring ring-one"/><span className="orbit-ring ring-two"/><span className="orbit-core">T</span><span className="orbit-node node-one">✓</span><span className="orbit-node node-two">↗</span></div></div>
    <div className="status-strip glass-panel"><div className="status-lead"><span className="status-icon">◎</span><span><strong>Human runbook loaded</strong><small>Reads, sandbox analysis, durable intent, approval stop</small></span></div><div className="status-divider"/><div className="status-metric"><span className="metric-check">✓</span><span><strong>Read only first</strong><small>Inventory remains untouched</small></span></div><div className="status-metric"><span className="metric-lock">Ⅱ</span><span><strong>Proofline guard</strong><small>Intent before action</small></span></div><span className="version-chip">v1.4</span></div>
    <div className="section-heading"><div><span className="section-kicker">TRACEHOLD WORKFLOW</span><h2>Start a recall investigation</h2></div><Link className="text-button" href="/admin">Approval queue <span>↗</span></Link></div>
    <div className="workflow-grid">
      <form className="form-card glass-panel" onSubmit={submit}>
        <div className="card-heading"><span className="number-badge">01</span><div><h3>Recall details</h3><p>Use the supplier notice as the source.</p></div><span className="mini-readonly">ANALYSIS ONLY</span></div>
        <div className="runbook-preview"><span className="runbook-label">BOUNDED RUNBOOK</span><span>Read lots & orders <b>→</b> sandbox impact <b>→</b> Proofline intent <b>→</b> approval</span></div>
        <div className="form-fields"><label>Recall reference<input name="recallId" required maxLength={120} defaultValue="SUP-2026-1042" placeholder="e.g. SUP-2026-1042"/></label><label>Supplier name<input name="supplier" required maxLength={200} defaultValue="Acme Components" placeholder="Enter supplier name"/></label><label>Affected lot IDs<input name="lotIds" required defaultValue="LOT-0001, LOT-0002" placeholder="LOT-0001, LOT-0002"/><small>Demo inventory already contains LOT-0001 and LOT-0002.</small></label><label>Reason for recall<textarea name="reason" required minLength={5} maxLength={2000} rows={3} defaultValue="Supplier reports thermal instability in the affected component batches." placeholder="Summarize the issue"/></label></div>
        <div className="form-footer"><span className="privacy-note"><span>⌑</span> No stock changes happen during analysis.</span><button className="primary-button" disabled={busy}>{busy ? "Agent is checking…" : "Run impact analysis"}<span>→</span></button></div>
      </form>
      <section className="evidence-card glass-panel" aria-live="polite">
        <div className="card-heading evidence-heading"><span className="number-badge number-muted">02</span><div><h3>Impact evidence</h3><p>Inventory, orders and prepared actions</p></div>{result && <span className="ready-pill"><i/> READY</span>}</div>
        {!result && !error && <div className="evidence-empty"><div className="empty-illustration"><span className="empty-circle circle-a"/><span className="empty-circle circle-b"/><span className="empty-core">⌕</span></div><strong>Ready to inspect real systems</strong><p>Submit the recall to run the bounded<br/>impact-analysis graph.</p><div className="empty-steps"><span>LOT LOOKUP</span><i/><span>BLAST RADIUS</span><i/><span>INTENT</span></div></div>}
        {error && <div className="error-state"><span className="error-symbol">!</span><strong>Review could not start</strong><p>{error}</p></div>}
        {result && <div className="results"><div className="result-banner"><span className="result-dot"/><div><strong>{result.impact.requiresOperatorReview ? "Operator review required" : "No affected orders found"}</strong><small>Reference {result.recallId} · {result.phase.replaceAll("_", " ")} · {result.source === "console-demo" ? "DEMO ADAPTER" : "LIVE SERVICES"}</small></div></div>{result.impact.lots.map((lot) => <article className="lot-card" key={lot.lotId}><div className="lot-title"><strong>{lot.productName}</strong><span>{lot.lotId}</span></div><div className="metrics"><div><small>SKU</small><strong>{lot.sku}</strong></div><div><small>ON HAND</small><strong>{lot.onHandUnits.toLocaleString()}</strong></div><div><small>ORDERS</small><strong>{lot.affectedOrders}</strong></div><div><small>UNITS</small><strong>{lot.orderedUnits}</strong></div></div><div className="lot-status">Inventory status: <strong>{lot.status}</strong></div></article>)}{result.impact.missingLotIds.length > 0 && <div className="missing">Not found: {result.impact.missingLotIds.join(", ")}</div>}<section className="action-review"><div className="action-review-heading"><strong>PROOFLINE ACTION REVIEW</strong><span>{result.actionPreviews.length} prepared</span></div>{result.actionPreviews.map((action) => <article className="action-preview" key={action.action_id}><div><strong>Quarantine {action.target_ref}</strong><small>{action.action_id}</small></div><span className="pending-pill">{action.state.replaceAll("_", " ")}</span></article>)}</section><div className="approval-stop"><span className="approval-symbol">Ⅱ</span><div><strong>Execution is paused</strong><span>{result.nextStep}</span><Link className="inline-action" href="/admin">Review in admin →</Link></div></div></div>}
      </section>
    </div>
    <section className="how-section"><div className="section-heading how-heading"><div><span className="section-kicker">ANCHOR-INSPIRED ACTION SAFETY</span><h2>Proof survives retries and crashes</h2></div><p>Each intent has an idempotency key, approval state and verified downstream outcome.</p></div><div className="step-cards"><article className="step-card glass-panel"><span className="step-icon">⌕</span><span className="step-index">STEP 01</span><h3>Observe the live state</h3><p>MCP tools read lots, linked orders and current warehouse status.</p></article><article className="step-card glass-panel"><span className="step-icon">◇</span><span className="step-index">STEP 02</span><h3>Commit the intent</h3><p>Proofline records what the agent wants to change before execution.</p></article><article className="step-card glass-panel"><span className="step-icon">Ⅱ</span><span className="step-index">STEP 03</span><h3>Approve and reconcile</h3><p>TrueForge pauses for a human, then records Applied, Not Applied or Unknown.</p></article></div></section>
    <PageFooter/>
  </div></AppShell>;
}
