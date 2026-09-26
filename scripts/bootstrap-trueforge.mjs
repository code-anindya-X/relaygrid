#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profilePath = resolve(projectRoot, "config/trueforge/relaygrid-operator.json");
const profile = JSON.parse(await readFile(profilePath, "utf8"));
const instructions = await readFile(resolve(projectRoot, profile.instructions_file), "utf8");

const trueforgeUrl = stripTrailingSlash(firstNonBlank(process.env.TRUEFORGE_URL) ?? "http://localhost:8790");
const configuredMcpUrl = firstNonBlank(process.env.OPS_MCP_PUBLIC_URL, process.env.OPS_MCP_URL)
  ?? "http://127.0.0.1:8083";
const mcpUrl = configuredMcpUrl.endsWith("/mcp")
  ? configuredMcpUrl
  : `${stripTrailingSlash(configuredMcpUrl)}/mcp`;
const mcpToken = firstNonBlank(process.env.MCP_BEARER_TOKEN);
const requestedModel = firstNonBlank(process.env.TRUEFORGE_MODEL_NAME, process.env.MODEL_NAME);
const waitSeconds = positiveInteger(process.env.TRUEFORGE_BOOTSTRAP_WAIT_SECONDS, 45);

await waitForTrueForge(waitSeconds);

const mcpManifest = {
  type: "remote",
  name: profile.mcp_server.name,
  url: mcpUrl,
  description: profile.mcp_server.description,
  ...(mcpToken
    ? { auth: { type: "header", headers: { Authorization: `Bearer ${mcpToken}` } } }
    : {}),
};

await request("/api/v1/settings/mcp-servers", {
  method: "PUT",
  body: { manifest: mcpManifest },
});
console.log(`TrueForge MCP registered: ${profile.mcp_server.name} -> ${mcpUrl}`);

const modelsResponse = await request("/api/v1/models");
const models = Array.isArray(modelsResponse.data) ? modelsResponse.data : [];
const availableNames = models
  .map((model) => model?.name)
  .filter((name) => typeof name === "string" && name.length > 0);
const selectedModel = chooseModel(availableNames, requestedModel);

if (!selectedModel) {
  console.log("RelayGrid MCP is ready, but the agent was not created because a model could not be selected safely.");
  if (availableNames.length === 0) {
    console.log(`Open ${trueforgeUrl}, go to Settings -> Models, configure a model, then run: npm run trueforge:bootstrap`);
  } else {
    console.log(`Available models: ${availableNames.join(", ")}`);
    console.log("Set TRUEFORGE_MODEL_NAME to one exact name above, then run: npm run trueforge:bootstrap");
  }
  process.exit(0);
}

const manifest = {
  model: {
    name: selectedModel,
    params: profile.model_params,
  },
  instructions,
  mcp_servers: [
    {
      name: profile.mcp_server.name,
      enable_tools: profile.enable_tools,
      disable_tools: [],
      preload_tools: profile.preload_tools,
      require_approval_for_tools: profile.require_approval_for_tools,
      // Eager schemas keep small local models from looping on get_tool_info
      // instead of executing RelayGrid's narrow operational tools.
      preload: true,
    },
  ],
  config: {
    iteration_limit: profile.runtime.iteration_limit,
    sandbox: {
      enabled: profile.runtime.sandbox,
      file_downloads: true,
    },
    dynamic_sub_agents: {
      enabled: profile.runtime.dynamic_sub_agents,
    },
    context_management: {
      compaction: { enabled: true },
      large_tool_response: { enabled: true },
    },
    generative_ui: { enabled: Boolean(profile.runtime.generative_ui) },
    ask_user_questions: { enabled: Boolean(profile.runtime.ask_user_questions) },
    web_search: { enabled: false },
  },
};

const agentsResponse = await request(`/api/v1/agents?limit=100&agent_name=${encodeURIComponent(profile.name)}`);
const exactAgent = Array.isArray(agentsResponse.data)
  ? agentsResponse.data.find((agent) => agent?.name === profile.name)
  : undefined;

if (exactAgent?.id) {
  await request(`/api/v1/agents/${encodeURIComponent(exactAgent.id)}`, {
    method: "PUT",
    body: { description: profile.description, manifest },
  });
  console.log(`TrueForge agent updated: ${profile.name} (${selectedModel})`);
} else {
  await request("/api/v1/agents", {
    method: "POST",
    body: {
      name: profile.name,
      description: profile.description,
      manifest,
    },
  });
  console.log(`TrueForge agent created: ${profile.name} (${selectedModel})`);
}

console.log(`Open ${trueforgeUrl} and select the ${profile.name} agent.`);

function chooseModel(available, requested) {
  if (requested) {
    if (available.includes(requested)) return requested;
    console.log(`Configured model "${requested}" is not available in TrueForge.`);
    return undefined;
  }
  return available.length === 1 ? available[0] : undefined;
}

async function waitForTrueForge(timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastError = "not reachable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${trueforgeUrl}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      lastError = `health returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
  }
  throw new Error(`TrueForge did not become ready at ${trueforgeUrl} within ${timeoutSeconds}s (${lastError})`);
}

async function request(path, options = {}) {
  const response = await fetch(`${trueforgeUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(process.env.TRUEFORGE_API_TOKEN
        ? { Authorization: `Bearer ${process.env.TRUEFORGE_API_TOKEN}` }
        : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: { message: text.slice(0, 300) } };
    }
  }
  if (!response.ok) {
    const message = data?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`TrueForge ${options.method ?? "GET"} ${path} failed (${response.status}): ${message}`);
  }
  return data;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function firstNonBlank(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}
