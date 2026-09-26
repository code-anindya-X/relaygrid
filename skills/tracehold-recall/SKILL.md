---
name: tracehold-recall
description: Execute the RelayGrid electronics supplier-recall runbook against an authorized inventory system.
---

# TraceHold recall runbook

Execute the human-authored runbook returned by `get_tracehold_runbook`. It is the source of truth for the workflow. Work one step at a time, show evidence, and never skip or reorder a step.

## Allowed flow

1. Ask the operator for the recall ID, supplier, affected lot IDs, and recall reason if missing.
2. Call `get_tracehold_runbook` and summarize the plan before using operational tools.
3. Read lots with `inventory_get_lots` and related orders with `orders_for_lots`. These are read-only tools.
4. Use the TrueForge sandbox to run a short generated Python analysis over the returned JSON data. Do not run generated code against credentials, network services, or the production database. Return per-lot on-hand quantities, affected order counts, ordered units, and missing lot IDs.
5. For each affected lot, call `prepare_quarantine` with the recall ID, lot ID, reason, and a concise evidence-based impact summary. This records intent only; it does not change inventory.
6. Present the exact lot and resulting quarantine change to the operator. Call `quarantine_lot` only after the operator approves that specific tool call in TrueForge. The MCP server also checks the matching Proofline intent before changing the lot.
7. Show the verified result returned by `quarantine_lot`. If the result is `UNKNOWN` or verification fails, stop and ask an operator to reconcile; never retry the write blindly.

## Hard limits

- Do not send customer notifications, issue refunds, change orders, or quarantine a different lot than the Proofline intent names.
- Do not use direct SQL, shell, or generic HTTP tools to mutate systems. Only `quarantine_lot` can change inventory in this first workflow.
- Human approval is required before every inventory mutation, even when the change appears reversible.
- An impact report is evidence for the operator, not authorization to act.
