#!/usr/bin/env node

const ollamaUrl = stripTrailingSlash(process.env.OLLAMA_URL ?? "http://localhost:11434");
const trueforgeUrl = stripTrailingSlash(process.env.TRUEFORGE_URL ?? "http://localhost:8790");
const modelId = process.env.OLLAMA_MODEL?.trim() || "qwen3:8b";
const providerName = process.env.TRUEFORGE_LOCAL_PROVIDER?.trim() || "local-ollama";
const modelName = process.env.TRUEFORGE_LOCAL_MODEL_ALIAS?.trim() || modelId.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();

await requireService(`${ollamaUrl}/api/version`, "Ollama", "Start it with: brew services start ollama");
await requireService(`${trueforgeUrl}/healthz`, "TrueForge", "Start RelayGrid with: ./scripts/dev-up.sh");

const tags = await requestJson(`${ollamaUrl}/api/tags`);
const installed = Array.isArray(tags.models) && tags.models.some((model) => model?.name === modelId);
if (!installed) {
  console.log(`Downloading local model ${modelId}. This is a one-time operation.`);
  await requestJson(`${ollamaUrl}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: modelId, stream: false }),
  });
}

await requestJson(`${trueforgeUrl}/api/v1/settings/model-providers`, {
  method: "PUT",
  headers: trueforgeHeaders(true),
  body: JSON.stringify({
    manifest: {
      type: "custom",
      name: providerName,
      base_url: `${ollamaUrl}/v1`,
      auth: { api_key: "ollama-local" },
      models: [
        {
          model_id: modelId,
          name: modelName,
          properties: {
            context_length: 32768,
            max_output_tokens: 4096,
            reasoning_efforts: ["none"],
          },
        },
      ],
    },
  }),
});

const configuredName = `${providerName}/${modelName}`;
console.log(`TrueForge local model ready: ${configuredName}`);
console.log("No external model API key is required.");

async function requireService(url, name, hint) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (response.ok) return;
  } catch {
    // The actionable error below is clearer than the fetch implementation detail.
  }
  throw new Error(`${name} is not reachable at ${url}. ${hint}`);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30 * 60 * 1000) });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} failed (${response.status}): ${text.slice(0, 300)}`);
  }
  return data;
}

function trueforgeHeaders(hasBody) {
  return {
    accept: "application/json",
    ...(hasBody ? { "content-type": "application/json" } : {}),
    ...(process.env.TRUEFORGE_API_TOKEN
      ? { authorization: `Bearer ${process.env.TRUEFORGE_API_TOKEN}` }
      : {}),
  };
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}