"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell, PageFooter } from "@/components/AppShell";
import type { WarehouseSnapshot } from "@/lib/types";
import styles from "./dashboard.module.css";

type Service = { id: string; name: string; status: string; latencyMs: number | null; url: string };

const capabilities = [
  { name: "Fleet conductor", detail: "Dispatches AGVs and adapts routes", state: "ACTIVE", icon: "◆", href: "/warehouse" },
  { name: "TraceHold", detail: "Recall impact and quarantine runbook", state: "READY", icon: "⌁", href: "/runbooks/tracehold" },
  { name: "Proofline", detail: "Durable intent and outcome ledger", state: "2 REVIEW", icon: "◇", href: "/admin" },
  { name: "TrueForge runtime", detail: "MCP tools, sandbox and agent loop", state: "OPEN", icon: "✦", href: "/agents" },
];

export default function DashboardPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [warehouse, setWarehouse] = useState<WarehouseSnapshot | null>(null);
  useEffect(() => {
    const load = () => {
      void fetch("/api/system", { cache: "no-store" }).then((response) => response.json()).then((data) => setServices(data.services ?? [])).catch(() => undefined);
      void fetch("/api/warehouse", { cache: "no-store" }).then((response) => response.json()).then(setWarehouse).catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 3500);
    return () => window.clearInterval(timer);
  }, []);

  const online = services.filter((service) => service.status === "online").length;
  return <AppShell section="Workspace" title="Command center"><div className={styles.page}>
    <section className={styles.hero}>
      <div className={styles.heroCopy}><div className="eyebrow"><span className="eyebrow-dot"/> AGENTIC OPERATIONS <span className="eyebrow-separator">·</span> NORTHSTAR</div><h1>One control plane for<br/><span>agents that move things.</span></h1><p>RelayGrid unifies warehouse robots, inventory, runbooks and irreversible actions. Agents can observe and plan; people retain the final say.</p><div className={styles.heroActions}><Link className={styles.primary} href="/warehouse">Open live digital twin <span>→</span></Link><Link className={styles.secondary} href="/runbooks/tracehold">Run TraceHold</Link></div></div>
      <div className={`glass-panel ${styles.heroVisual}`} aria-label="RelayGrid system map">
        <div className={styles.meshCore}><span className={styles.corePulse}/><strong>RG</strong><small>CONTROL PLANE</small></div>
        <span className={`${styles.meshNode} ${styles.nodeOne}`}><i>TF</i><b>TrueForge</b></span>
        <span className={`${styles.meshNode} ${styles.nodeTwo}`}><i>AG</i><b>AGV fleet</b></span>
        <span className={`${styles.meshNode} ${styles.nodeThree}`}><i>PL</i><b>Proofline</b></span>
        <span className={`${styles.meshNode} ${styles.nodeFour}`}><i>M</i><b>Ops MCP</b></span>
        <svg className={styles.meshLines} viewBox="0 0 440 300" aria-hidden="true"><path d="M220 150 91 74M220 150 350 66M220 150 365 232M220 150 92 232"/><circle cx="220" cy="150" r="82"/></svg>
      </div>
    </section>

    <section className={styles.signalBar}>
      <div><span className={styles.signalDot}/><span><strong>{online}/{services.length || 5} services responding</strong><small>Live local runtime status</small></span></div>
      <div><strong>{warehouse?.kpis.robotsOnline ?? 4}</strong><small>AGVs ONLINE</small></div>
      <div><strong>{warehouse?.kpis.activeMissions ?? 3}</strong><small>ACTIVE MISSIONS</small></div>
      <div><strong>2</strong><small>APPROVALS WAITING</small></div>
      <a href="http://localhost:8790" target="_blank" rel="noreferrer">Open TrueForge ↗</a>
    </section>

    <div className={styles.sectionHead}><div><span className="section-kicker">OPERATIONAL MODULES</span><h2>Everything connected, every action bounded</h2></div><Link href="/agents">View architecture →</Link></div>
    <section className={styles.capabilityGrid}>{capabilities.map((capability) => <Link href={capability.href} className={`glass-panel ${styles.capability}`} key={capability.name}><span className={styles.capabilityIcon}>{capability.icon}</span><span><strong>{capability.name}</strong><small>{capability.detail}</small></span><em>{capability.state}</em><span className={styles.arrow}>↗</span></Link>)}</section>

    <section className={styles.lowerGrid}>
      <div className={`glass-panel ${styles.warehouseCard}`}>
        <div className={styles.cardHead}><div><span className="section-kicker">WAREHOUSE PULSE</span><h2>{warehouse?.warehouse.name ?? "Northstar Fulfilment"}</h2></div><Link href="/warehouse">Enter twin ↗</Link></div>
        <div className={styles.miniFloor}>
          {(warehouse?.zones ?? []).map((zone) => <div key={zone.id} className={styles.miniZone} style={{ left: `${zone.x / 60 * 100}%`, top: `${zone.y / 40 * 100}%`, width: `${zone.width / 60 * 100}%`, height: `${zone.depth / 40 * 100}%`, background: zone.color }}><span>{zone.name}</span></div>)}
          {(warehouse?.robots ?? []).map((robot) => <span key={robot.id} className={`${styles.miniRobot} ${robot.state === "blocked" ? styles.blocked : ""}`} style={{ left: `${robot.x / 60 * 100}%`, top: `${robot.y / 40 * 100}%` }} title={`${robot.name}: ${robot.state}`}>◆</span>)}
          {!warehouse && <div className={styles.floorLoading}>Synchronizing digital twin…</div>}
        </div>
      </div>
      <div className={`glass-panel ${styles.activityCard}`}>
        <div className={styles.cardHead}><div><span className="section-kicker">AGENT ACTIVITY</span><h2>Recent decisions</h2></div><Link href="/admin">Audit log ↗</Link></div>
        <div className={styles.timeline}>
          {(warehouse?.activity ?? [
            { id: "1", message: "TrueForge connected Operations MCP", createdAt: new Date().toISOString(), kind: "agent" },
            { id: "2", message: "TraceHold prepared quarantine intent", createdAt: new Date().toISOString(), kind: "approval" },
          ]).slice(0,5).map((event) => <div key={event.id}><span className={styles.timelineDot}/><span><strong>{event.message}</strong><small>{event.kind.toUpperCase()} · {new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></span></div>)}
        </div>
      </div>
    </section>
    <PageFooter/>
  </div></AppShell>;
}
