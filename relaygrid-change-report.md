# Project Change Report — RelayGrid

## New names

- **RelayGrid** is the product formerly called RobotixFunnel.
- **Proofline** is the shared action-integrity agent formerly referred to as Anchor.
- **TraceHold** is the recall-containment workflow formerly called LotLock.

## Selected theme: Runbook Executor

The project is based on the event's **Runbook Executor** idea. TraceHold is a human-written electronics recall runbook: read affected lots and orders, run generated impact analysis in a sandbox, and stop for explicit human approval before every state-changing step. The event page calls its six named builds starting points rather than closed categories.

## Connected workflows

- **TraceHold:** recall notice → read affected lots and orders → calculate impact → show evidence → create a Proofline intent → human approval → scoped quarantine → verify persisted state.
- **Warehouse On-call:** anomaly → correlated incident and evidence → recall verified episodes → prepare a bounded intent → human approval → MCP execution → `APPLIED`, `NOT_APPLIED`, or `UNKNOWN` verification → resolve and retain the episode.

Repeated on-call execution requests run receipt reconciliation only. They do not repeat the robot mutation.

## Service split

| Service | Language | Responsibility |
| --- | --- | --- |
| Console | TypeScript | Recall intake, 3D digital twin, on-call incident command and operator review |
| Control plane | TypeScript + LangGraph | Bounded workflow APIs, public reads and credential-protected lifecycle routing |
| Impact engine | Python | Deterministic impact calculations, warehouse state, incident memory and action receipts |
| Proofline | Java | Durable action intent, idempotency, approval, execution claim and outcome ledger |
| Operations MCP server | TypeScript + MCP | Runbook and warehouse reads, intent preparation, approved actions and reconciliation |
| Local operations | Shell | Service startup and infrastructure commands |

PostgreSQL is used for local development and action-ledger persistence. TrueForge is the required hackathon agent harness; TrueFoundry gateways connect governed agents, model traffic and MCP tools when provisioned.

## Current implementation state

The monorepo includes the recall Console, 3D warehouse twin, on-call center, LangGraph control plane, Python impact and incident engine, authenticated Operations MCP server, Proofline action ledger, local start scripts, runbooks, and a bootstrapped TrueForge agent. Operator mutations require a signed Console session, and lifecycle requests between the Console and control plane use a server-side credential. TrueForge requires approval for `quarantine_lot` and `execute_incident_remediation`.

The fast demo runs with an explicitly labelled `demo-memory` action store. The durable deployment path uses PostgreSQL and Proofline; live warehouse, robot-fleet and identity-provider connectors remain deployment work.

The original Anchor repository is a design reference. Proofline and the warehouse incident loop are fresh implementations of durable intent, idempotency, three-valued verification, and crash-safe reconciliation.
