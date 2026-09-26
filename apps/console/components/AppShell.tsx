"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const links = [
  { href: "/", label: "Command center", icon: "grid" },
  { href: "/on-call", label: "On-call center", icon: "pulse" },
  { href: "/warehouse", label: "Digital twin", icon: "cube" },
  { href: "/runbooks/tracehold", label: "Runbooks", icon: "route" },
  { href: "/admin", label: "Approvals", icon: "shield", badge: "2" },
  { href: "/agents", label: "Agent mesh", icon: "spark" },
];

function Icon({ name }: { name: string }) {
  const path: Record<string, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    pulse: <><path d="M3 12h4l2.2-5 4.1 10 2.1-5H21"/><circle cx="12" cy="12" r="9" opacity=".3"/></>,
    cube: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4.3 7.7 7.7 4.4 7.7-4.4M12 12v9"/></>,
    route: <><circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h3a3 3 0 0 0 3-3V9a3 3 0 0 1 3-3"/></>,
    shield: <><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6z"/><path d="m9 12 2 2 4-4"/></>,
    spark: <><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/></>,
  };
  return <svg className="nav-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path[name]}</svg>;
}

export function AppShell({ children, section, title, actions }: { children: ReactNode; section: string; title: string; actions?: ReactNode }) {
  const pathname = usePathname();
  return <main className="app-shell">
    <aside className="sidebar glass-panel">
      <Link className="brand" href="/" aria-label="RelayGrid home"><span className="brand-symbol"><span/><span/><span/></span><span>relaygrid<small>PHYSICAL AI CONTROL</small></span></Link>
      <div className="workspace-picker"><span className="workspace-avatar">N</span><span className="workspace-name"><strong>Northstar Supply</strong><small>WH-BLR-01 · Live</small></span><span className="chevron">⌄</span></div>
      <nav className="side-nav" aria-label="Main navigation">
        <p className="nav-label">OPERATIONS</p>
        {links.map((link) => <Link key={link.href} href={link.href} className={`nav-item ${pathname === link.href || (link.href !== "/" && pathname.startsWith(link.href)) ? "active" : ""}`}><span className="icon-mark"><Icon name={link.icon}/></span>{link.label}{link.badge && <span className="nav-count">{link.badge}</span>}</Link>)}
      </nav>
      <div className="sidebar-bottom">
        <a className="harness-card" href="http://localhost:8790" target="_blank" rel="noreferrer"><span className="harness-logo">TF</span><span><strong>TrueForge harness</strong><small>Agents · tools · sandbox</small></span><span className="harness-arrow">↗</span></a>
        <div className="profile-row"><span className="profile-avatar">AS</span><span><strong>Alex Sharma</strong><small>Operations lead</small></span><span className="profile-menu">···</span></div>
      </div>
    </aside>
    <section className="main-content">
      <header className="topbar"><div className="breadcrumbs"><span>{section}</span><span>/</span><strong>{title}</strong></div><div className="topbar-right">{actions}<span className="environment"><i/> LOCAL SYSTEM</span><Link className="icon-button" href="/admin" aria-label="Open approvals"><span>⌁</span><b/></Link></div></header>
      {children}
    </section>
  </main>;
}

export function PageFooter() {
  return <footer className="page-footer"><span><span className="footer-mark">R</span> RELAYGRID <i>·</i> PROOFLINE ACTION INTEGRITY</span><span>Every physical write carries an intent, approval, and verified outcome.</span></footer>;
}
