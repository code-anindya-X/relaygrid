# TrueForge local integration

RelayGrid pins TrueForge `0.2.1` as a project dependency. This avoids downloading a different release every time the local stack starts.
The `npm run trueforge` command explicitly allows only `localhost` and `127.0.0.1` through TrueForge's private-network outbound URL guard so the standalone process can reach the local Operations MCP service.

## Start and register RelayGrid

```sh
npm install
npm run trueforge
```

With TrueForge and the Operations MCP service running, use a second terminal:

```sh
npm run trueforge:bootstrap
```

The bootstrap is safe to run repeatedly. It creates or replaces the `relaygrid-operations` MCP connector at `http://127.0.0.1:8083/mcp`. It reads `MCP_BEARER_TOKEN` from `.env` and sends the value directly to TrueForge; the token is never written to a generated config file or printed.

The script then reads configured models. It creates or updates the `relaygrid-operator` agent when exactly one model exists, or when `TRUEFORGE_MODEL_NAME` names an available model. When there are zero or multiple models, MCP registration still completes and the script prints the remaining model-selection step.

For a TrueForge instance with authentication enabled, set `TRUEFORGE_API_TOKEN`. For a remote TrueForge deployment, set `TRUEFORGE_URL`. If that deployment cannot reach the local loopback MCP endpoint, set `OPS_MCP_PUBLIC_URL` to its reachable HTTPS MCP URL.

## Approval boundary

The agent profile in `config/trueforge/relaygrid-operator.json` exposes narrow RelayGrid tools. `quarantine_lot` is explicitly listed in `require_approval_for_tools`, so TrueForge pauses for a person before the state-changing call. Proofline separately verifies that the approved call matches a durable action intent and records the downstream outcome.
