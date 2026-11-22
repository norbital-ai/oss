# Capability inventory

Native unless noted; optional host facilities left `off` fail `Unavailable`.

- **Data:** `+model.ts` (all Bolt kinds, `ref` 1:N/M:N/polymorphic/owned, `constraints` unique/check/`no_overlap`/`locked`, `computed`, `indexes` text/semantic/custom vector, `record_label`), `custom_field`, validated runtime configuration models, system history/audit, generated SQL migrations, `bolt.query` filters/paging/aggregates/search.
- **Workflow:** per-verb transforms/effects/refusals, `state` + locks, automations (`job`/`call`, cron + `rest`, write triggers, `ctx.wait`), file syncs (`with: 'file'`), source teams/policies/inline approvals, Effect `BigDecimal`/`DateTime` + CEL, optional `ctx.convert.document`/`record`/`ingest`.
- **People, comms & AI:** runtime `sys_envoy` + `sys_integration.envoy`, `+agent.md`/`+agent.external.md`, workspace/personal skills, agent automations (`agent: 'confirm'`), policy-granted MCP, `ctx.ai.sys_1`/`sys_2`/embeddings, mail/chat/in-app notices, `+secrets.ts`, `file` fields + `ctx.files`, public/external SSR apps, kiosks, `portal: true`, `embed`, phone `signup`.
- **Mediated (external):** remote model syncs (cursors, outbox, idempotency, rollback), `http`/`sqlserver` integrations (`ctx.request`, signed `webhook.verify`/`handle`), `ctx.web.read`, browser JS/WASM packages.
- **UI:** apps/groups/pages, tables/boards/forms/matrices/charts/pivots/maps, record views, typed inputs/editors, camera/liveness, typed i18n, layout primitives.
- **Not tenant capabilities:** platform billing/metering, Studio authoring tools.
