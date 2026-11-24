---
name: integration-sync
agent: true
authoring: true
description: Enforce the sync-first integration boundary — sync external systems 1-to-1 into local models via model syncs, read local models everywhere else, allow on-demand live reads only on explicit user opt-out or when full continuous syncing is unnecessary (view-time or report/agent snapshots), and audit workspaces for violations.
---

# Sync-first integration boundary

External systems of record sync 1-to-1 into local models once; everything else reads local models only, unless an explicit exception applies.

## Protocol

1. **Isolate polling to the sync layer.** Every recurring poll or 1-to-1 mirror of an external system (ERP, accounting, CRM, inventory, HRIS, ticketing, SQL DB, SaaS API) lives strictly in `src/data/model/**/+<sync>.sync.ts` and adapters in `src/integration/<name>/`, plus verified `webhook.handle` callbacks. Never run background polling loops (`setInterval`, refetch timers, polling `cron` automations) from pages, representations, reports, automations, transforms, effects, `src/lib/` or agents.
2. **Read local models by default.** Pages, representations, reports, policies, automations, transforms, effects and agents read synced local models (`ctx.query` / `PageBolt.query` over SSE / `aggregate`). Derive freshness and outage state from local timestamps and `sys_integration.status` (`failing`, `health`, connection state) via pure local helpers — never by querying the external system when a synced model serves it.
3. **Keep sync polling efficient and idle-quiet.** Each `+<sync>.sync.ts` `read` advances incremental cursors (monotonic IDs, rowversions, change logs or snapshot digests), emits zero rows when unchanged so idle ticks write nothing and serverless DBs stay asleep, bounds page windows, detects hard deletes cleanly, and keeps probes in `+integration.ts` `test`. Separate source-owned fields from local workflow fields (approvals, overrides, notes) so refreshes never clobber local state.
4. **Route outbound mutations cleanly.** Sync-backed writes go through `+<sync>.sync.ts` `write` (FIFO outbox, no-echo, approval wait, idempotency, retries, dead letters). Direct `ctx.request` / `ctx.send` outside syncs is for explicit event- or user-triggered actions (messaging, payments, bookings) — never background polling.
5. **Exceptions — on-demand live reads.** Skip continuous 1-to-1 model syncing only when either:
   - the user explicitly asks not to continuously sync that source into local models; or
   - the workspace does not need the full dataset every minute and only needs fresh values at discrete moments — when the current view/dashboard opens (bounded read-only `mode: 'call'` automation with `cache`) or when a report/agent run snapshots them onto its output record (value, rate/price, timestamp, source), e.g. live FX rates, market quotes or on-demand lookup inputs.
6. **Choose 1-to-1 sync vs on-demand read.** Default to continuous 1-to-1 sync when the workspace needs an authoritative local mirror (identity, lifecycle, joins, permissions/approvals, search, cross-screen reuse, outage resilience). Use an on-demand live read only under rule 5 — still with zero background polling loops.
7. **Audit before merge.** Scan outside `+<sync>.sync.ts` and `src/integration/<name>/` for `ctx.request`, `ctx.integration`, external `fetch`, adapter calls, `setInterval`/timer polls or polling `cron` automations. Flag every background poll outside syncs and any direct read outside rule 5 or rule 4; verify every `+<sync>.sync.ts` short-circuits on idle.

## Routing

- Drivers, webhooks & channels: `authoring-tenant-workspace`, `references/agents-and-integrations.md`
- Sync declarations & ownership: `authoring-tenant-workspace`, `references/models-and-modeling.md`
- Triggers & `rest`: `authoring-tenant-workspace`, `references/automations-and-effects.md`
- Exact shapes: `bolt-contract`, `sync.md` and `integration.md`
