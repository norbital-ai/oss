# Bolt cutover preparation

This is the current preparation contract for the isolated OSS refactor. It authorizes no tenant operation.
Source, OSS fixtures and regression sources have been updated; their presence is not verification. The
tenth coordinated lint run exited 1 with ten of eleven Turbo tasks successful. UI source and test-source
checks passed; Bolt's source check reported seventy errors and five warnings across thirty-six files.
Those diagnostic joins have source corrections. The subsequent source review reopened page/native result
validation, generator attachment, device adapters and aggregate/error inference before another gate.
These source changes and their dependent callers remain under review. Whole-repository lint has not passed; no standalone build gate or test suite
has run. Dependency builds,
declaration checks, documentation generation and cell bundling have run as lint prerequisites. Root owns
the frozen-tree gates: lint → build → headless/PGlite tests in order.
Older green results and historical “pending” journal entries do not establish current acceptance.

Templates, HR/payroll and `TEMPLATE_MIGRATION.md` are deferred untouched. Colony/HQ, live providers,
native PostgreSQL acceptance, staging, production and tenant activation are outside this task.
No tenant is upgraded in place: at the cut every tenant is wiped and reseeded on the new Bolt (see
[Cutover plan](#cutover-plan)). No upgrade API, stored-data converter or old-vocabulary reader ships in OSS or the realm.

## Settled owner decisions

All fifteen decisions are answered; none remains an owner-decision blocker.

1. Snake case includes author-facing declarations, context, UI props/helpers and test-kit methods.
2. Sync update and delete must refuse locked rows.
3. A retry may repeat an earlier committed write; no automatic per-position write deduplication.
4. Integrations own webhooks; automation webhook declarations/dispatch are removed.
5. Keep integration/editor companions and adequate creation/configuration support.
6. Custom approval notifications run in effects; platform default notices remain.
7. Use one non-partial unique constraint marked `import_key: true` (implementation choice delegated).
8. Leave HR/payroll and templates untouched; remove Bolt’s `attaches` API.
9. A delete's transform returns no rows; it may carry other models' writes (`with`, `on_approved`) into its commit (owner, 0.0.28).
10. Use PGlite only; add no native PostgreSQL/staging acceptance suite.
11. Preserve fleet-browser refresh. Explicit refresh before inspection is the implementation choice;
    ordinary workspace tabs retain streams, with no replacement tenant polling timer.
12. Accounts are arbitrary durable runtime records and must reopen after host restart.
13. Administrators choose allowed chat models and budgets in runtime administration.
14. Retain screen features, including sorting, manual refresh, file transfer and delivery counters.
15. No in-place upgrade: every tenant is wiped and reseeded; migrations are rebuilt from scratch.

The later fan-out decision sends changes to **all active connections of that integration, including
imported rows**. A row-pinned connection and separate attach action were not selected. Restarting an
earlier chat message creates a new chat, retains the original and keeps current workspace source/data.
Requested UI improvements intentionally replace the audit’s original pixel-equivalence requirement;
structural extraction and vocabulary-only changes still require rendered parity evidence.

## Current source contracts, awaiting validation

| Area | Current contract |
| --- | --- |
| Models | Twelve author keys: description, was, icon, record_label, fields, constraints, indexes, outputs, create, update, delete, syncs. No author `table`; private built-in binding/lowering retains native primary/identity metadata. Shared metadata/native model types derive from concrete codecs; authored generic trees/callbacks keep their actual types. |
| Writes and policies | Nested output/column trees, one act map, target revisions, per-verb before/set/after and changed fields, literal approval flows, output-scoped history, `ctx.query`/`ctx.query.after` and `ctx.refuse`. Carried writes use returned `with`/`on_approved`. Teams have one object entry (`name?`, `parent?`, `policies`). |
| Calls and sync controls | Public `.upsert`, authored transactions, old tool/start paths and act-level conflict options are removed. Keyed `.import` owns its input conflict policy, including refuse; native keyed-write update/keep is a separate language. Map options accept key. Server aggregation stays inside query; bare aggregate remains page-only. |
| Manual sync | `POST /__bolt/sync` carries `{ model, sync, id, input, issued_at }`, matching idempotency/contract headers; pages use `sync_control(model, sync, input)` and Norbius uses its sync tool. Remote refresh requires model read plus `capabilities.syncs: ['model.sync_name']` unless admin. Native `<model>.sync.<sync>` handlers, run history/progress and starter-owned file results retain their identities. |
| Runtime ownership | `sys_envoy` and `sys_integration` are runtime records; source slots/default provisioning are removed. Keep account IDs, owners, envoy/conversation refs, replica bindings and the tenant sealing key. Admin AI settings replace source models/default; required AI facilities/embedding declarations remain. |
| Fields and text | `many`, `ref`, `on_delete`/`set_null`, inline computed fields and strict unknown-key refusal. Field label/help descriptors are refused recursively; standalone UI Kind/Field presentation overrides remain. Captions/help use `models.<model>.fields.<field>` / `.help.<field>`, `automations.<name>.input.fields.<field>` / `.input.help.<field>`, and `integrations.<name>.configuration.fields.<field>` / `.configuration.help.<field>`. Supply successor catalogues; do not rename literal business JSON. |
| Labels and scalar data | Own/inline labels are generated/indexed; one-hop labels evaluate against current related rows under the declared layer’s field/row grants, including search and approval references. Hidden dependencies fall back to the key. Stored decimals retain scale, int8 remains text, native timestamps retain sub-millisecond precision and public timestamps retain millisecond projection. JSON is structural data, not a scalar coercion hint. |
| Predicate language | Exclusion is not+in; list groups use and/or+has and explicit null/array comparisons. Period containment is `contained_by`, endpoints `starts_within`/`ends_within`; geographic within stays separate. This preserves features because containment differs from overlap. The variable is `requestor.team_tree`. |
| Native live/queue ownership | Captures carry actual writing transaction IDs. Retained plans are get/read/request; patch arrivals, unset and named-root metadata replacement have matching consumers. Private per-root snapshots/version fences remain ephemeral. No fabricated captures, syncChanged bridge, Nudges service or tenant polling replacement. |
| Tool/context ownership | Fixed model tools discover host/MCP operations through their native envelopes; tool owners supply behavior metadata. Tool results are bounded once before storage, never re-clipped at send. Native/provider/DOM/Effect protocol names and frozen archive formats retain explicit adapters. |
| Browser ownership | User workspace page navigation/control is supplied only to an admitted root web UI. Envoys/children/runs may use the separate fleet browser with isolated profiles; they never borrow a member’s browser identity. Fleet documents set `window.bolt_live_mode = 'snapshot'` before boot and await scoped `window.bolt_refresh()` before inspection. |
| Chat/UI | Structured input card; steer queue; shared attachment previews/file cards; 68rem responsive column and full-width steps; bounded/deduplicated approval cards; inline envoy/channel setup; any-earlier-message restart; client-scoped drafts; read-history accordion; native bottom-origin latch/detach/Latest. Dedicated panel owners replace the former monolith without extra component wrappers. Rendering and interaction evidence are outstanding. |
| Recovery and push | Native turn failures retain recovery when failure evidence cannot be committed; missing chat differs from failed lookup. RunError retains sqlstate and optional outcome_unknown:true. Push waits for worker activation and suppresses only a focused visible same-workspace tab. Required notice IDs, web tags/APNs collapse IDs and existing bounded transient retries support coalescing, not exactly once. |
| Channel admission | A valid unpaired conversation account retains durable queued messages with no delivery attempt or sent timestamp. Connected status persists before queue resumption, including restart and already-due rows. Only provider acceptance or authoritative accepted-delivery evidence establishes sent time. Notification admission reports queued/skipped; business reports must follow each channel's actual delivery evidence. |

Public helper/import changes must be adopted directly, not hidden behind aliases. Concrete names and private-host
obligations are listed in [COLONY_FOLLOWUPS.md](COLONY_FOLLOWUPS.md). Generated system names and the skill corpus
must be rebuilt from current source; `scripts/system-names.ts` owns ignored `src/system/names.ts`, using scoped
scratch/atomic rename and the shared literal printer. No hand-written fallback index is supplied.

## Cutover plan

The owner decided against in-place upgrade. There is one physical generation: every table carries the current
native row rules, foreign keys carry their declared delete action, and no snapshot, applied slice, history row or
audit receipt from an older Bolt is read, planned from or converted.

1. **Rebuild migrations from scratch.** In each template, delete `migrations/` (SQL, `snapshot.json`,
   `migrations.lock.json`, `physical.json`, archives) and run `bolt build` to generate a fresh `0001_initial.sql`
   with its proofs. Commit them together. No predecessor prefix, checksum or archive is retained.
2. **Preserve Colour Matching's user data as seed data.** Before the wipe, dump its business records and files into
   its seed-bank tree in the current model shape, reviewed against the new schema. Runtime accounts, sessions,
   credentials, envoys, conversations, queued work, history and audit receipts are not carried; integration owners
   re-connect after the reseed.
3. **Release.** Publish the immutable `@norbital-ai/*` set, relock and push the templates; CI uploads each release.
4. **Wipe and reseed each tenant.** Pause admission, drop the tenant database, provision it from the new release and
   seed it (`env reset` locally, `env deploy reset` deployed; Colour Matching from its preserved seed-bank tree).
   Nothing from the old database is adopted, so there is no drain, adoption or rollback-to-old-release step beyond
   restoring the pre-wipe backup if the reseed fails.
5. **Verify the successor.** Boot host/shell/engine together on the reseeded tenant and exercise sign-in, ordinary/held/
   carried writes, history restore, jobs, envoys, sync controls, files, public apps and UI.

## Required evidence before any later activation

| Evidence family | Meaningful cases |
| --- | --- |
| Public/type/corpus | Current import/export and old-key refusal; strict nested kind/output/source/compiled metadata across driver/auth/parser/search arms; generated SystemNames bootstrap/cache restore/declaration inference; exact guest/corpus boundaries; calendar cycles/DST, decimal/billing arithmetic and unchanged host-MAC bytes. |
| Schema/reseed | Fresh `0001_initial.sql` replays to the declared physical definitions; every tenant wiped and reseeded; Colour Matching seed tree reproduces its records and file bytes. |
| Authority/history | Held and carried atomicity; approve/reject same-request race; removed reviewer; ChangesRequested reject; admin/team supersede; replaced-file rollback; nested checkpoint resubmit/fingerprints; restore of fields that no longer fit the current schema; selected output/layer grants and guard baselines. |
| Scalars/query/live | Large/exact decimals and averages, int8, microsecond/pre-epoch rounding, period/null/list/shape semantics, own/dynamic labels and hidden refs; initial read/capture parity; counts/off-page changes; delayed/reordered captures/answers; replacement authority; patch arrivals/unset/multi-root totals/files/status and Last-Event-ID replay. |
| Sync lifecycle | Zero/one/many/inactive/unrelated/new/reactivated accounts; same-statement account edits; imported create/update/delete and source corrections; id-less ack/null skip; key adoption/snapshot end; paused tombstones/history pruning; FIFO/coalescing/replay/renewal/stale claims; bounded/interrupted backfill; generation change/failure/replay; peer success/late ack during refusal/recovery. |
| Jobs and host | Queued work during long wakes, refused/late pulses, settlement failure, parking/interruption/retirement; crash before claim/after claim/after local commit/after external accept/before settle; receipt and scheduled-transfer recovery; failed lookup and undurable turn-failure evidence. |
| Messaging/tools | Cron → durable send → provider acknowledgement → same-thread question; early SMTP reply/report before ack; pre-registration failure before I/O; same-time replies and cross-recipient/account isolation; invalid receipts/ABI; uncertainty/idempotency; paired transcript conversion; compaction/steer/repeated call IDs/confirmation races; fixed tool/catalogue and behavior/display parity. |
| UI/browser/device | Wide/narrow/keyboard/reduced-motion layouts; questions/queues/files/approval overflow; unified inline setup; restart ownership/files/budgets; draft close/switch/remount; initial async/streaming tail, image growth/detachment/older-page insertion/panel resizing/Latest; read accordion stability; native browser open/failure/close and snapshot recovery; worker activation/background suppression/retry. |

OSS test and type-source handoffs identify prepared cases; they have not run against this final tree. Root’s
current lint/build/test logs, physical-prefix/artifact/corpus evidence and headless results must be assessed
at the requirement’s scope. PGlite/fakes cannot certify native lock contention, live provider delivery, OS
notifications, private host scheduling or sealed backup recovery. Those remain operator/host obligations,
not fabricated green results or additional native acceptance suites in this task.
