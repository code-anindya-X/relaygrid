"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell, PageFooter } from "@/components/AppShell";
import styles from "./agents.module.css";

type Service = { id: string; name: string; status: "online" | "offline" | "degraded"; latencyMs: number | null; url: string };

const agents = [
  { id: "fleet-conductor", name: "Fleet Conductor", role: "Plans missions and resolves route contention", tools: ["warehouse_snapshot", "fleet_status", "dispatch_robot"], risk: "approval for dispatch", icon: "◆" },
  { id: "tracehold", name: "TraceHold", role: "Investigates recalls and prepares containment", tools: ["inventory_get_lots", "orders_for_lots", "prepare_quarantine"], risk: "approval for quarantine", icon: "⌁" },
  { id: "proofline", name: "Proofline", role: "Commits intent before physical actions", tools: ["intent ledger", "idempotency", "outcome reconciliation"], risk: "durable guard", icon: "◇" },
  { id: "sentinel", name: "Floor Sentinel", role: "Explains anomalies and proposes recovery", tools: ["digital_twin_state", "fleet_status", "runbook lookup"], risk: "read only", icon: "◉" },
];

const servicesMeta = [
  { id: "trueforge", language: "TypeScript", owner: "Agent loop, sessions and approvals" },
  { id: "control-plane", language: "TypeScript · LangGraph", owner: "Bounded workflows and orchestration" },
  { id: "impact-engine", language: "Python", owner: "Impact math and digital twin simulation" },
  { id: "proofline", language: "Java", owner: "Durable intent, idempotency and audit" },
  { id: "operations-mcp", language: "TypeScript · MCP", owner: "Narrow tools over operational systems" },
];

export default function AgentsPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const load = () => void fetch("/api/system", { cache: "no-store" }).then((response) => response.json()).then((data) => setServices(data.services ?? [])).catch(() => undefined);
    load(); const timer = window.setInterval(load, 3000); return () => window.clearInterval(timer);
  }, []);
  const trueforge = services.find((service) => service.id === "trueforge");
  const rows = useMemo(() => servicesMeta.map((meta) => ({ ...meta, service: services.find((item) => item.id === meta.id) })), [services]);

  async function copyMcp() {
    await navigator.clipboard.writeText("http://127.0.0.1:8083/mcp\nAuthorization: Bearer local-mcp-token-change-me");
    setCopied(true); window.setTimeout(() => setCopied(false), 1600);
  }

  return <AppShell section="Runtime" title="Agent mesh" actions={<a className={styles.topAction} href="http://localhost:8790" target="_blank" rel="noreferrer">Open TrueForge ↗</a>}><div className={styles.page}>
      <section className={styles.hero}><div><div className="eyebrow"><span className="eyebrow-dot"/> TRUEFORGE RUNTIME <span className="eyebrow-separator">·</span> OPERATIONS MCP</div><h1>Agents that can see,<br/><span>reason and safely act.</span></h1><p>TrueForge runs the model loop, sandbox and approval checkpoints. RelayGrid exposes narrow operational tools; Proofline makes every write recoverable and auditable.</p><div className={styles.actions}><a className={styles.primary} href="http://localhost:8790" target="_blank" rel="noreferrer">Launch agent harness <span>→</span></a><button className={styles.secondary} onClick={copyMcp}>{copied ? "Copied MCP config ✓" : "Copy MCP connection"}</button></div></div><div className={`glass-panel ${styles.runtimeCard}`}><span className={`${styles.runtimeState} ${trueforge?.status === "online" ? styles.online : ""}`}><i/>{trueforge?.status === "online" ? "TRUEFORGE ONLINE" : "WAITING FOR TRUEFORGE"}</span><div className={styles.runtimeLogo}>TF</div><strong>RelayGrid Operations Agent</strong><p>14 bounded MCP tools · sandbox enabled · destructive tools require approval</p><div className={styles.runtimeStats}><span><b>4</b><small>AGENTS</small></span><span><b>14</b><small>MCP TOOLS</small></span><span><b>3</b><small>GUARDRAILS</small></span></div></div></section>

    <div className={styles.sectionHead}><div><span className="section-kicker">AGENT ROSTER</span><h2>Specialists share one operational truth</h2></div><span>Human checkpoints remain global</span></div>
    <section className={styles.agentGrid}>{agents.map((agent) => <article className={`glass-panel ${styles.agentCard}`} key={agent.id}><header><span>{agent.icon}</span><div><h3>{agent.name}</h3><small>{agent.id}</small></div><em>READY</em></header><p>{agent.role}</p><div className={styles.tools}>{agent.tools.map((tool) => <span key={tool}>{tool}</span>)}</div><footer><span>GUARD</span><strong>{agent.risk}</strong></footer></article>)}</section>

    <section className={styles.architecture}>
      <div className={styles.sectionHead}><div><span className="section-kicker">POLYGLOT SERVICE MESH</span><h2>Each language owns what it does best</h2></div><span>{rows.filter((row) => row.service?.status === "online").length}/{rows.length} live</span></div>
      <div className={`glass-panel ${styles.serviceTable}`}>{rows.map((row) => <div key={row.id}><span className={`${styles.serviceDot} ${row.service?.status === "online" ? styles.serviceOnline : ""}`}/><span><strong>{row.service?.name ?? row.id}</strong><small>{row.owner}</small></span><em>{row.language}</em><b>{row.service?.status ?? "offline"}{row.service?.latencyMs ? ` · ${row.service.latencyMs}ms` : ""}</b></div>)}</div>
    </section>

    <section className={`glass-panel ${styles.flow}`}><div className={styles.flowIntro}><span className="section-kicker">ACTION LIFECYCLE</span><h2>The agent cannot skip the stop.</h2><p>Read tools run directly. Every physical change must pass through the same chain.</p></div><div className={styles.flowSteps}><span><b>1</b><strong>Observe</strong><small>MCP reads live state</small></span><i>→</i><span><b>2</b><strong>Simulate</strong><small>Sandbox checks impact</small></span><i>→</i><span><b>3</b><strong>Commit intent</strong><small>Proofline records scope</small></span><i>→</i><span><b>4</b><strong>Human approval</strong><small>TrueForge pauses</small></span><i>→</i><span><b>5</b><strong>Act & verify</strong><small>Outcome reconciled</small></span></div></section>
    <PageFooter/>
  </div></AppShell>;
}
