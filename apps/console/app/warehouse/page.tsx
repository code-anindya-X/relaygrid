"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell, PageFooter } from "@/components/AppShell";
import { WarehouseTwin } from "@/components/WarehouseTwin";
import type { WarehouseSnapshot } from "@/lib/types";
import styles from "./warehouse.module.css";

export default function WarehousePage() {
  const [snapshot, setSnapshot] = useState<WarehouseSnapshot | null>(null);
  const [selectedRobot, setSelectedRobot] = useState<string>();
  const [busy, setBusy] = useState("");

  const refresh = useCallback(async () => {
    const response = await fetch("/api/warehouse", { cache: "no-store" });
    if (response.ok) setSnapshot(await response.json());
  }, []);

  const advance = useCallback(async () => {
    const response = await fetch("/api/warehouse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "tick" }),
    });
    if (response.ok) setSnapshot(await response.json());
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void advance(), 1800);
    return () => window.clearInterval(timer);
  }, [advance, refresh]);

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    try {
      const response = await fetch("/api/warehouse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
      if (response.ok) setSnapshot(await response.json());
    } finally { setBusy(""); }
  }

  const selected = useMemo(() => snapshot?.robots.find((robot) => robot.id === selectedRobot), [snapshot, selectedRobot]);
  const content = !snapshot ? <div className="loading-stage"><span className="loading-spinner"/><strong>Connecting to the warehouse twin…</strong></div> : <>
    <div className={styles.hero}>
      <div><div className="eyebrow"><span className="eyebrow-dot"/> LIVE PHYSICAL AI <span className="eyebrow-separator">·</span> {snapshot.warehouse.id}</div><h1>Warehouse <span>digital twin.</span></h1><p>Watch every AGV, route, inventory zone and exception in one operational model. Commands are scoped, recorded and approval aware.</p></div>
      <div className={styles.heroActions}>
        <button className={styles.button} disabled={!!busy} onClick={() => act("inject_anomaly")}>Inject anomaly</button>
        <button className={styles.button} disabled={!!busy} onClick={() => act("create_order")}>+ Demo order</button>
        <button className={styles.buttonPrimary} disabled={!!busy} onClick={() => act("toggle")}>{snapshot.warehouse.running ? "Pause twin" : "Resume twin"}</button>
      </div>
    </div>
    <section className={styles.kpis}>
      <div className={`glass-panel ${styles.kpi}`}><span className={styles.kpiIcon}>◈</span><span><strong>{snapshot.kpis.robotsOnline}/{snapshot.robots.length}</strong><small>ROBOTS ONLINE</small></span></div>
      <div className={`glass-panel ${styles.kpi}`}><span className={styles.kpiIcon}>↗</span><span><strong>{snapshot.kpis.activeMissions}</strong><small>ACTIVE MISSIONS</small></span></div>
      <div className={`glass-panel ${styles.kpi}`}><span className={styles.kpiIcon}>▦</span><span><strong>{snapshot.kpis.ordersToday}</strong><small>ORDERS TODAY</small></span></div>
      <div className={`glass-panel ${styles.kpi}`}><span className={styles.kpiIcon}>◷</span><span><strong>{snapshot.kpis.avgPickMinutes}m</strong><small>AVG. PICK TIME</small></span></div>
    </section>
    <div className={styles.mainGrid}>
      <section className={`glass-panel ${styles.twinCard}`}><WarehouseTwin snapshot={snapshot} selectedRobot={selectedRobot} onSelectRobot={setSelectedRobot}/></section>
      <aside className={styles.rightRail}>
        <section className={`glass-panel ${styles.panel}`}><div className={styles.panelHead}><h2>AGV fleet</h2><span className={styles.source}><i/>{snapshot.source === "warehouse-engine" ? "ENGINE" : "DEMO ADAPTER"}</span></div><div className={styles.robotList}>{snapshot.robots.map((robot) => <button key={robot.id} className={`${styles.robot} ${selectedRobot === robot.id ? styles.robotSelected : ""}`} onClick={() => setSelectedRobot(robot.id)}><span className={styles.robotIcon}>◆</span><span><strong>{robot.name} · {robot.id}</strong><small className={styles.state}>{robot.state} · {robot.target ?? "Awaiting work"}</small></span><span className={styles.battery}>{Math.round(robot.battery)}%</span></button>)}</div>{selected && <div className={styles.selectedActions}><button onClick={() => act("robot", { robotId: selected.id, command: selected.state === "paused" ? "resume" : "pause" })}>{selected.state === "paused" ? "Resume" : "Pause"}</button><button onClick={() => act("robot", { robotId: selected.id, command: "charge" })}>Charge</button><button onClick={() => act("robot", { robotId: selected.id, command: "clear_anomaly" })}>Clear</button></div>}</section>
        <section className={`glass-panel ${styles.panel}`}><div className={styles.panelHead}><h2>Live missions</h2><span>{snapshot.missions.length} total</span></div>{snapshot.missions.slice(0,4).map((mission) => <div className={styles.mission} key={mission.id}><div className={styles.missionTop}><strong>{mission.orderRef} · {mission.stage}</strong><span>{Math.round(mission.progress)}%</span></div><div className={styles.track}><div className={styles.fill} style={{ width: `${mission.progress}%` }}/></div></div>)}</section>
        <section className={`glass-panel ${styles.panel}`}><div className={styles.panelHead}><h2>AI anomaly desk</h2><span>{snapshot.anomalies.length} open</span></div>{snapshot.anomalies.length === 0 ? <div className="quiet-state">No operational anomalies.</div> : snapshot.anomalies.slice(0,3).map((anomaly) => <div key={anomaly.id} className={`${styles.alert} ${anomaly.severity === "high" ? styles.alertHigh : ""}`}><strong>{anomaly.type.replaceAll("_", " ")} · {anomaly.severity}</strong><span>{anomaly.message}</span></div>)}</section>
      </aside>
    </div>
  </>;

  return <AppShell section="Operations" title="Digital twin"><div className={styles.page}>{content}<PageFooter/></div></AppShell>;
}
