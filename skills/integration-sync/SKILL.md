---
name: integration-sync
agent: true
authoring: true
description: Enforce the sync-first integration boundary — sync external systems 1-to-1 into local models via model syncs, read local models everywhere else, allow on-demand live reads only on explicit user opt-out or when full continuous syncing is unnecessary (view-time or report/agent snapshots), and audit workspaces for violations.
---

# Sync-first integration boundary

External systems of record sync 1-to-1 into local models once; everything else reads local models only, unless an explicit exception applies.

## Protocol

1. **Separate data integrations from channel integrations.** Data integrations (ERP, accounting, CRM, HRIS, ticketing, calendar, SQL, HTTP) sync 1-to-1 into local models via `src/data/model/**/+<sync>.sync.ts` and `src/integration/<name>/` (plus verified `webhook.handle`). Channel integrations (`whatsapp`, `email`, `slack`, `discord`, `telegram`, `wechat`, `chat`) ingest into `sys_conversation`/`sys_message` via `listen` + `classifier` and trigger `on: [{ model: 'sys_message', verbs: ['create'] }]` automations — never mirror chat/email with custom syncs or polling crons. Never run background polling loops (`setInterval`, refetch timers, polling crons) outside syncs.
2. **Read local models by default.** Pages, representations, reports, policies, automations, transforms, effects and agents read synced local models (`ctx.query` / `PageBolt.query` / `aggregate`) and derive freshness/outages from local timestamps and `sys_integration.status`.
3. **Keep syncs incremental and idle-quiet.** Each `+<sync>.sync.ts` `read` advances incremental cursors (monotonic IDs, rowversions, change logs, snapshot digests), emits zero rows when unchanged so idle serverless DBs sleep, bounds pages, detects hard deletes, and keeps probes in `+integration.ts` `test`. Separate source-owned fields from local workflow fields.
4. **Route outbound mutations cleanly.** Sync-backed writes go through `+<sync>.sync.ts` `write` (FIFO outbox, no-echo, approval wait, idempotency, retries). Direct `ctx.request` / `ctx.send` is for explicit user/event actions (messaging, payments, bookings), never polling.
5. **Exceptions — on-demand live reads.** Skip 1-to-1 sync only when the user explicitly opts out of continuous sync, or when fresh values are needed only at discrete moments — on view load (cached read-only `mode: 'call'` automation) or report/agent snapshots (e.g. live FX rates, market quotes).
6. **Choose 1-to-1 sync vs on-demand read.** Default to continuous sync when identity, lifecycle, joins, permissions, approvals, search or outage resilience matter; use rule 5 otherwise, still with zero polling loops.
7. **Audit before merge.** Scan outside `+<sync>.sync.ts` and `src/integration/<name>/` for `ctx.request`, `ctx.integration`, external `fetch`, timers or polling crons; verify every sync short-circuits on idle.

## Routing

- Drivers, webhooks & channels: `authoring-tenant-workspace`, `references/agents-and-integrations.md`
- Sync declarations & ownership: `authoring-tenant-workspace`, `references/models-and-modeling.md`
- Triggers & `rest`: `authoring-tenant-workspace`, `references/automations-and-effects.md`
- Exact shapes: `bolt-contract`, `sync.md` and `integration.md`
