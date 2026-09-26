const services = [
  { id: "trueforge", name: "TrueForge", url: process.env.TRUEFORGE_URL ?? "http://localhost:8790", healthPath: "/api/v1/capabilities" },
  { id: "control-plane", name: "Control plane", url: process.env.CONTROL_PLANE_URL ?? "http://localhost:8084", healthPath: "/health" },
  { id: "impact-engine", name: "Impact engine", url: process.env.IMPACT_ENGINE_URL ?? "http://localhost:8002", healthPath: "/health" },
  { id: "proofline", name: "Proofline", url: process.env.PROOFLINE_URL ?? "http://localhost:8082", healthPath: "/v1/actions/health" },
  { id: "operations-mcp", name: "Operations MCP", url: process.env.OPS_MCP_URL ?? "http://localhost:8083", healthPath: "/health" },
];

export async function GET() {
  const checked = await Promise.all(services.map(async (service) => {
    const startedAt = performance.now();
    try {
      const response = await fetch(`${service.url}${service.healthPath}`, { cache: "no-store", signal: AbortSignal.timeout(800) });
      return { ...service, status: response.ok ? "online" : "degraded", latencyMs: Math.round(performance.now() - startedAt) };
    } catch {
      return { ...service, status: "offline", latencyMs: null };
    }
  }));
  return Response.json({ services: checked, checkedAt: new Date().toISOString() });
}
