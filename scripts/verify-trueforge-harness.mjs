#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const trueforgeUrl = stripTrailingSlash(process.env.TRUEFORGE_URL ?? "http://localhost:8790");
const profile = JSON.parse(await readFile(new URL("../config/trueforge/relaygrid-operator.json", import.meta.url), "utf8"));

const [modelsResponse, agentsResponse, connectorsResponse] = await Promise.all([
  request("/api/v1/models"),
  request(`/api/v1/agents?limit=100&agent_name=${encodeURIComponent(profile.name)}`),
  request("/api/v1/settings/mcp-servers"),
]);

const models = Array.isArray(modelsResponse.data) ? modelsResponse.data : [];
const agent = Array.isArray(agentsResponse.data)
  ? agentsResponse.data.find((candidate) => candidate?.name === profile.name)
  : undefined;
const connector = Array.isArray(connectorsResponse.data)
  ? connectorsResponse.data.find((candidate) => candidate?.name === profile.mcp_server.name)
  : undefined;

assert(models.length > 0, "No TrueForge model is configured");
assert(agent, `Agent ${profile.name} is missing`);
assert(connector, `MCP connector ${profile.mcp_server.name} is missing`);
assert(connector.auth_status?.status === "authenticated", "RelayGrid MCP connector is not authenticated");

const manifest = agent.manifest ?? {};
const agentConnector = Array.isArray(manifest.mcp_servers)
  ? manifest.mcp_servers.find((candidate) => candidate?.name === profile.mcp_server.name)
  : undefined;
assert(agentConnector, "Agent is not connected to the RelayGrid MCP server");
assert(manifest.config?.sandbox?.enabled === true, "TrueForge sandbox is not enabled");
assert(manifest.model?.params?.parallel_tool_calls === false, "Parallel tool calls must be disabled for bounded actions");
assert(manifest.model?.params?.reasoning_effort === "none", "Local model reasoning must be disabled for predictable demo latency");
assert(manifest.model?.params?.max_tokens === 2048, "Agent output must be bounded to 2048 tokens");
assert(models.some((model) => model?.name === manifest.model?.name), `Agent model ${manifest.model?.name ?? "<missing>"} is unavailable`);

const enabledTools = new Set(agentConnector.enable_tools ?? []);
const approvalTools = new Set(agentConnector.require_approval_for_tools ?? []);
const missingTools = profile.enable_tools.filter((tool) => !enabledTools.has(tool));
const missingApprovalGates = profile.require_approval_for_tools.filter((tool) => !approvalTools.has(tool));
assert(missingTools.length === 0, `Agent is missing tools: ${missingTools.join(", ")}`);
assert(missingApprovalGates.length === 0, `Approval gates are missing: ${missingApprovalGates.join(", ")}`);
assert(agentConnector.preload === true, "MCP schemas are not eagerly preloaded");

console.log(`PASS  Agent: ${profile.name}`);
console.log(`PASS  Model: ${manifest.model.name}`);
console.log(`PASS  Authenticated MCP: ${profile.mcp_server.name}`);
console.log(`PASS  Narrow tool surface: ${profile.enable_tools.length} tools`);
console.log(`PASS  Human approval gates: ${profile.require_approval_for_tools.join(", ")}`);
console.log("PASS  Sandbox enabled, output bounded, reasoning and parallel tool calls disabled");

async function request(path) {
  const response = await fetch(`${trueforgeUrl}${path}`, {
    headers: {
      accept: "application/json",
      ...(process.env.TRUEFORGE_API_TOKEN
        ? { authorization: `Bearer ${process.env.TRUEFORGE_API_TOKEN}` }
        : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`TrueForge GET ${path} failed (${response.status})`);
  return data;
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL  ${message}`);
}

function stripTrailingSlash(value) {
  let result = value;
  while (result.endsWith("/")) result = result.slice(0, -1);
  return result;
}