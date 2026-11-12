# Colony and external-host adoption

These are follow-ups for a later matched host/engine/shell release. Private Colony/HQ, fleet, live configuration
and deployed providers were not inspected or changed. OSS source and regression files remain unvalidated.
No deployment, tenant operation or new native PostgreSQL acceptance suite is authorized here.
The cutover wipes and reseeds every tenant; its plan and activation blockers live in [BOLT_CUTOVER.md](BOLT_CUTOVER.md).

## ABI, database and package boundaries

- Adopt the actual **Host API 18** boundary and matching cell loader. Import HostPorts, CELL_ABI_VERSION, Kernel and CellEnd from `@norbital-ai/bolt/host-api`; retired engine HostPorts/SecretsPort/TenancyPort and interactive database-session lease APIs are removed. This records current source, not a deployment or further version bump.
- Return one ordered Rows result per requested database statement, including capture reads; zero statements return zero results. Audited batches contain context, every requested result and receipt before framing is removed. Missing/excess/sparse results are permanent XX000 contract failures, while legitimate zero-row Rows remain empty/not-found.
- A transaction protocol failure leaves commit/rollback unverified and retains write/identity invalidation: preserve optional outcome_unknown:true/sqlstate across native/foreign-graph codecs, never infer rollback or blindly retry it. XX000 stays permanent; without a receipt audit outcome is unresolved, while an actual receipt may prove commit even though the caller still fails on the malformed answer. Read/capture cardinality failures have no uncertainty marker; foreign-graph decoding preserves literal true only.
- Apply verified SQL migration bundles through apply_migrations; remove applyPlan imports. Template migrations are rebuilt from scratch for the cut; keep strict current SchemaSnapshot/AppliedSchemaSlice original/fingerprint/schema fields. There is one physical generation: TableSpec has no `native_rules`/`managed_deletes`, every table renders the current native row rules and declared FK delete actions, and `managed_tables`/`SnapshotSchemaSpec`/`SnapshotTableSpec` are removed.
- The control store's committed snapshot no longer renders the physical objects its older chain applied (no `native_rules` revisions, no `store_audit_update`). Rebuild `apps/colony/src/lib/technical/migrations` from scratch with a wiped control store, or hand-write and replay-verify the step that moves the applied chain to the current generation before generating the next file; production holds real accounts, so the choice is the owner's.
- Wiped tenants hold no unversioned history, missing-expiry audit receipts, former audit layouts or grace table; nothing is disposed. Runtime history has no startup stamp/name fallback/legacy UI flag; current receipts require their finite per-operation expiry.
- Consume concrete current compiled model/sync/integration/MCP/group/custom/output/catalog codecs, including no_overlap, record_label, period_of and label_link. Preserve native ModelSpec physical primary/identity metadata; author table/TableSpec is removed and private built-in bindings are not host APIs. Do not replace codecs with object-only assertions or old-key translations.
- Include generated `.norbital/models/*.ts` and `.norbital/integrations/*.ts` in Studio/language-service inputs; their public runtime factories are in `/declarations`. Build-generated SystemNames and the skill corpus must match the exact package set; never supply an empty/frozen fallback index.
- Move to explicit engine exports. Remove imports of WritesLive/ApprovalsLive/compileCommit, RunTime/backoffMs and retired ToolJson/ToolRun/ToolFiles; use the supported native ABI. The shared plain-text pager is window(text, from, to, bytes, 'text').
- Use native ImageMetadata, ConvertSettings, ParsedCallable and NoticeInsert at their actual owners; authored ImageFacts, ConvertOptions and string Callable retain their distinct roles. Adopt public_url, call_id, read_only, wall_ms and current snake-case host/facility config/hooks through their real adapters, not forwarding aliases.
- Preserve nullable import_start on both HostCredentials open/read rows, including retirement/retry wrappers. Keep the native/encoded Promise adapter’s actual argument/result types, signal cancellation and administrative versus release-native failure channels; the omitted-field normalizer is gone.

## Runtime ownership and admission

- After the reseed, create runtime sys_envoy rows from the source defaults with their policies, task, delegation, audience, group handling, DM behavior and triage scope; later source changes never overwrite runtime settings.
- Retire source-slot account provisioning. Preserve arbitrary sys_integration IDs/owners, credential bindings, sealing key, conversations and replicas across restart; await LinkManager.resume and its unresolved restore failures. Source reconstruction must not delete or remint runtime accounts.
- Move chat-model permissions/default selection/monthly caps to runtime administrator settings; source workspace.ai retains required capabilities/embeddings. Preserve host class resolution and the concrete admin model catalogue; policy request-rate limits stay separate from dollar caps.
- Read kiosk surfaces from apps with shell:kiosk/audience while preserving their route namespace. Session admission reads the active database session on each request for cross-activation revocation; account for its actual database-wake cost instead of retaining an authentication cache fallback.
- Remove host speech facility/provider configuration; keep Convert transcription and server conversion. Do not restore the removed page convert capability.
- Read policy grants through output-scoped read/history and current verb/capability metadata. Remote manual refresh uses capabilities.syncs, while automations grants name declared automations only; do not widen refresh to all readers.

## Queue, captures, delivery and recovery

- Adopt the shared deadline wake/pulse callbacks and await announce/settle/teardown promises. ActiveWorkspace.pulse({signal}) reuses the active compute owner; refused pulses remain scheduled, and parking/retirement/late answers are fenced. Retire the separate host sleep loop and takeDue/complete/DeadlineResolution. callbackAtEpochMs/mergeAnnouncements remain current callback-result fields.
- Replace Runs.nudge with Wake.at for actual queued work. Native identity carries publication:bootstrap until EngineLive binds its real Live publisher, then publishes captured mutations and explicit wake. Nudges/generic identity events.announce and Live.syncChanged are removed; do not fabricate business captures to replace them.
- Preserve each capture’s actual top-level SQL transaction ID through the host membrane. Inbox/per-root snapshots remain private and ephemeral. Match live patch arrivals, unset{key}, named-root meta replacement, version fences and notice-stream Last-Event-ID replay; never let a delayed answer replace a newer/replaced subscription.
- The wiped databases have no bolt_notice_deliver/bolt_notice_push triggers; the notice statement queues captured delivery/push.
- Require PushMessage.id through actual transport payload/decoder and updated scoped worker assets. Keep bolt.push `{ids}` jobs and existing bounded transient retry; stable web tags/SHA256 APNs collapse IDs coalesce accepted repeats without exactly-once claims or another ledger. Later verify VAPID/team keys, subscriptions, browser/OS permission, scope and background delivery in the real matched host.
- Match RunError’s optional sqlstate/outcome_unknown:true and native agent.turn/agent.scheduled bounded transient retry. Failed lookup/undurable failure evidence must not become gone/success or discard the sole takeover; scheduled transfer/takeover remains atomic. A leased child is not reported finished.
- Forward fenced outbound_ref events and shared SendReceipt provider_id/presume_after_ms/idempotent_sends metadata. SMTP persists its reference before submission; registration/queue admission is not provider acceptance. Preserve early reply/report evidence, recipient/account/epoch/attempt fences and atomic inbound message/reply/hints/admission. Unknown non-idempotent outcomes need actual reconciliation, not automatic resend.
- Keep valid unpaired-account messages durably queued with zero attempts and no sent timestamp. Persist connected status before resuming already-due and future queued rows; restore accounts and queue wakeups together after restart. Consume notification admission as queued/skipped, and derive custom report Sent status from actual per-channel receipt/status evidence.
- Preserve native sync/backfill/drain identities, claim leases/frozen external keys, replica-local maps and all-active-account fan-out including imported rows. Never derive bindings from absence alone or use source slots for routing.

## Browser, agent and HQ integration

- Implement abortable BrowserPort.open/close and typed BrowserSnapshot results (url, nullable title, text and declared metadata) for navigate/snapshot/act/open_workspace. Register scoped cleanup before opening, including partial-open failure; surface typed port errors, not an old JSON-result fallback.
- Keep user-browser page navigation/control root-web-only. Fleet browser profiles for envoys/runs stay isolated by identity/conversation, never borrowed from a member. Adopt AgentHostConfig.browser_tools via with_browser and retain host/MCP policy admission.
- Remove boltLivePoll/poll-mode injection. Set window.bolt_live_mode='snapshot' before a fleet document boots and await its scoped window.bolt_refresh() before every inspection/screenshot. It waits for query delivery/Svelte render; report refresh failures, and never recast an acknowledged write as uncertain because its observer refresh failed. Ordinary tabs retain streaming views.
- Retire model run_tool/sandbox dispatch while keeping Studio source tools and run_js file mode. Workspace tools are policy-bearing call-mode automations reached through the fixed act tool; match automation mode/input/run/effect vocabulary with the shell and release.
- Use fixed host and mcp list/call envelopes. Preserve call IDs, assistant associations, complete input/results and native display{name,args}. Script tool(name,input) keeps its own whitelist; no old direct-name model aliases.
- Supply HostTool.behavior explicitly, including empty objects: progress_check for workspace_test/workspace_diagnose; diagnostics for workspace_diagnose/workspace_preview/workspace_validate; discovery for workspace_lang; data for browser/web_search/workspace_read/search/list_dir/lang/diagnose/test/preview/try; browser downloads and resume{argument:'from'}. Pure means argument-only within the turn, independently of read_only. Preserve behavior in chat/inference/tool-row projection.
- Ship structured question/options/answered/answer_to and the matching sys_message.post answer admission together. Use the generated integration.md contract and runtime-account cron send guidance; remove guessed envoy.md/source-slot instructions without fabricating a file alias. Native identity row-event triggers never existed at the isolated base; use explicit automation/cron reconciliation instead of promising them.
- Keep merge approval summaries short and user-facing; retain evaluation/technical evidence separately. Adopt approval-ID deduplication and bounded overflow while preserving data-loss warnings/decision controls.
- Adopt independent sys_message.restart and lineage/copied_from fields. Historical copied messages cannot expose live approval/page/child controls or count as new spend. Keep the actual workspace client alive across panel close for workspace/member/conversation drafts; reload persistence is not promised. Editing/attachment replacement is separate from restart and leaves workspace source/data current.
- Use native inline envoy.create/integration.create/integration.manage or shared IntegrationCard from `/page/integrations` for HQ/programmatic setup. Adopt integration_client/integration_offers and PageContext.integration_offers; keep configuration_tab companions, durable disconnect and explicit account deletion distinct. Remove external modal/card nesting or side-sheet handoffs when adopting that native flow.
- Adopt shared Bell’s stable per-open membership: inbox placeholder, old-read collapsed disclosure, unchanged badge/grouping/workspace updates and one bounded scroll region. A separately implemented HQ center must adopt those semantics itself; its private implementation was not inspected.
- Match snake-case Studio boot/mount/state/operation helpers, including mount_studio; the manifest view has no remotes. Remove unused StudioPort.build/usage, StudioBuildRecord/StudioUsage and GET /studio/build,/studio/usage consumers, while retaining actual inspection/build-state/log streaming.

## Current vocabulary and preparation ownership

- Adopt the matching wire/SDK set: request_id, schema_version/restored_from, requested_by/team_names/user_names/rolled_back, proposal_moves/restriction reasons and native error codes. Public acts use key, not once or act-level on_conflict; keyed import owns its separate conflict policy. Agent writes use decodeActs/calls.acts, not a separate AgentEngine.act route.
- Use current page/shell/mount/callable helpers: create_bolt, send_code, shell_bolt, shell_api, mount_shell, initialize_shell_assets, hydrate_public_page, open_stream, http_client, initial_read, on_notice, integration_setup/integration_setups, workspace_name, public_routes, custom_fields and native_modules. Conversation/notification methods include set_model/respond_now/execute_plan/claim_page_action/mark_read. Media/test summaries use content_type/taken_at/no_text/duration_ms.
- Adopt integration base_url, layout_html conversion, system-1 cost_usd, browser label_paths/readonly_fields/proposal_only, site_key, provider base_url/api_key/tolerate_unread, expected_revision/case_sensitive and parent_model/parent_id/parent_revision URL context. Vendor sitekey/inputSchema/response/HTTP/DOM/Effect/Capacitor protocols remain at their real adapter boundary. Host AI uses tool_calls while opaque stored native toolCalls retains its explicit adapter.
- Adopt sent_at/source_at/reply_to/sender_name/replied_to, import_start/selected_at, expires_at and last_disconnect in their actual envelopes. Preserve provider-original/raw bodies, BCC, accepted receipts and opaque values.
- Move successor field captions/help to model, automation-input and integration-configuration catalogue namespaces. Strict FieldData/OutputData reject inline label/help; standalone presentation overrides remain. Read/output/native shape projection codecs must not invent a field-help renderer or ignore unknown source keys.
- Migrate filters to not/in, has groups and explicit null/array comparisons; use contained_by/starts_within/ends_within for period behavior and requestor.team_tree at the author boundary. Geographic within and native stored teamTree stay distinct. No runtime old-name aliases.
- Update actual helper imports directly: sha256_hex/to_hex; open_ai_embeddings/ai_modality_refusals/open_router_chat/deep_seek_routing/session_of/configuration_defaults/public_read_key/automation_fields; read_failure/act_failure/facility_failure/act_failure_tag; split_model/layer_models/column_layers/nullable_of_expr/file_re/match_dir/role_at; client_page/local_text/decode_status/ui_messages_for/decode_read_request/dynamic_read/plan_read_request; UI by_id/first_of/page_of/request_json and native table_of/tables_of/browser_catalog. Native-only system lowering is not a host author API.
- Adopt Std date/calendar/CSV/JSON/wire/vars/kind/label/pricing/facts/zone/billing helper spellings and metadata. Decimal methods are from_number/to_number/round_to/is_zero, modes half_up/half_even; calendar keys opens_on/second_opens_on/semi_month; zone ms_of_day; host refusal bad_signature and facility retry_after_ms. Billing uses up_to/stripe_price_ids/unit_amount_decimal/meter_id/tiers_mode/trial_days/allow_promotion_codes. Preserve algorithms, money/provider identities, MAC bytes and native toString/toJSON/valueOf hooks.
- Adopt shared UI snake-case layout/editor/form/overlay/root/option/callback members, including before_row/array_keys/changes_only/on_files/default_open/on_pending_change/load_older/has_older/filter_count. Primitive namespaces use actual Root/Content/Trigger parts; prefixed aliases are removed. Distinct ContentPrimitive/OverlayPrimitive remain; Bits internals retain native options. Keep component elements, focus/dismissal/bindings/styles and requested new chat layout/interaction behavior.
- Adopt window.bolt_device/window.bolt_device_ready, open_settings, navigation.open_external and notification on_open in custom host devices. Preserve actual native plugin/IPC contracts behind the adapter; Bolt and OSS app-shell producers already use the current source names.
- There is no stored-data preparation: the realm one-off upgrade script is deleted and no upgrade API exists. Every tenant is wiped and reseeded on the new release.
- Colour Matching's records and files return from its preserved seed-bank tree; its runtime accounts and credentials are re-connected by their owners, not carried.
- Now Effects: `@norbital-ai/bolt` `docs` (`(yield* docs).symbol(...)`), `history_schema_objects`, store `plan`/`destructive_steps`/`generate`/`generate_squash` `extra` callbacks (return `Effect<readonly SchemaObject[], E>`), `exposure`/`read_catalog`, `compile_authority`, `Authorities.compile/visitor/system`. Boots carry `operation_outputs`; act/sync bodies send `issued_at`; conflict records have no `fields`.
- 0.0.25 carries main's 0.0.24 features in this vocabulary. `bolt_approvals.state` admits `Withdrawn` in its CHECK (the requester's `withdraw` decision; a run of the automation that raised a request may withdraw it), and `approval_request.status` admits `WITHDRAWN`; HQ approval views and counters must treat it as closed, never as rejected. Touching a record held by an automation-raised request refuses `under_approval`.
- Integration sync recovery adds shell routes `GET /__bolt/shell/instance-sync-dead-letters?instance=` and `POST /__bolt/shell/instance-sync-retire` (`{ instance, id }`, a member with instance update access); `ShellApi` names them `instance_sync_dead_letters` and `retire_instance_sync`. A host that proxies or reimplements the shell's integration sheet adopts both.

## Test kit engine (`test_engine`)

The kit's engine assembly moved into Bolt behind `test_engine(options)` / `TestEngine` (`@norbital-ai/bolt/tooling`); the internals it named are no longer exported. Colony tests that import them:

- `GuestIsolates`, `Activation` (`@norbital-ai/bolt/engine`) in `tests/kernel-guest-{code-cache,constructor,pool,runner}.test.ts` and `tests/support/guest-fixture.ts`: drive the runner through HostApi (`HostPorts.guests` and activation) or a `test_engine` workspace with `guests`.
- `Keys` (`/engine`) in `tests/hosting-secrets.test.ts`: supply the key port through HostApi (`Facilities.keys`) and read secrets through the activated workspace.
- `EngineActor` (`/engine`) in `tests/foundation-browser.ts`: use `Authority['actor']` (`Authority` stays exported).
- `unmet` (`/facilities`) in `tests/facilities-ports.test.ts`: assert through `activate`/HostApi activation, which refuses naming every unmet need.

## Export surface: one home per symbol, derived types

Bolt's entries now export each symbol once; the types a host hands over or gets back derive from their parent
(`HostApi`, `HostPorts`, `Facilities`, `StudioState`/`StudioView`/`StudioPort`). Below, `ActiveWorkspace` means
`Awaited<ReturnType<HostApi['activate']>>`, `System2` means `Exclude<Facilities['intelligence']['system2'], typeof off>`,
`BrowserPort` means `Exclude<HostPorts['browser'], typeof off>`, `HostApi`/`HostPorts` come from `/host-api` and
`Facilities`/`off` from `/facilities`.

- Subpaths removed: `/guest-hooks` (its exports are in `/node`), `/page/integrations` (`IntegrationSetup` and
  `IntegrationSetupEntry` are in `/page`), `/tooling/browser`. `/host-api` and `/artifact` are now listing entries.
- `/host-api` exports `HOST_API`, `HOST_API_VERSION`, `HostApi`, `HostPorts`, `HostFailure`, `HostApiFailure`,
  `MigrationImpact`, `render_mode`, `CellEnd`, `Kernel`. Derive the rest (`src/lib/services.ts`,
  `src/lib/kernel/cells.ts`, `src/lib/hosting/host-api.ts`, `src/lib/hosting/shell-ports.ts`,
  `src/lib/facilities/{ports,integrations}.ts`, `tests/{facilities-ports,facilities-integrations,hosting-host-api}.test.ts`):
  `ActiveWorkspace` as above; `BranchPorts` `Parameters<HostApi['branch']>[0]`; `WorkspaceBranch`
  `Awaited<ReturnType<HostApi['branch']>>`; `PackLoad` `Awaited<ReturnType<WorkspaceBranch['packs']['load']>>`;
  `LinkHost` `Parameters<HostApi['links']>[0]`; `HostCredentials` `Awaited<ReturnType<HostApi['links']>>['credentials']`;
  `Release` `HostPorts['release']`; `ShellPorts` `HostPorts['shell']`; `AgentPorts` `HostPorts['agent']`;
  `HostTenantDb` `HostPorts['facilities']['storage']['database']`; `MintedSession`
  `NonNullable<Awaited<ReturnType<ActiveWorkspace['identity']['mint']>>>`; `FounderAnswer`
  `Awaited<ReturnType<WorkspaceBranch['identity']['founder']>>` (the answer is already decoded; Colony needs no Schema).
- `/engine` port and answer types (P9): `DeadlinesPort` `HostPorts['deadlines']`; `DocsPort` `HostPorts['docs']`;
  `LinksPort` `Awaited<ReturnType<HostApi['links']>>['port']`; `BrowserPort` as above, `BrowserStep`
  `Parameters<BrowserPort['act']>[1][number]`, `BrowserViewport` `NonNullable<Parameters<BrowserPort['navigate']>[4]>`;
  `GuestIsolatesPort` `HostPorts['guests']`, `GuestSessionOptions` `Parameters<HostPorts['guests']['open']>[1]`;
  `LogPort` `Facilities['logs']['runtime']`, `LogEvent` `Parameters<Facilities['logs']['runtime']['write']>[0]`;
  `CronEntry` `Awaited<ReturnType<ActiveWorkspace['crons']>>[number]`, `CronFired`
  `Awaited<ReturnType<ActiveWorkspace['fire']>>`; `AiModel` `Awaited<ReturnType<NonNullable<System2['catalog']>>>['models'][number]`;
  `SearchRequest`/`SearchAnswer` from `NonNullable<HostPorts['agent']['search']>` (its second parameter, its answer);
  `WorkspacePort` `NonNullable<Awaited<ReturnType<NonNullable<HostPorts['agent']['draft']>>>>`; `WorkspaceNote`
  `Awaited<ReturnType<NonNullable<HostPorts['agent']['events']>>>[number]`; `PhoneVerifier`
  `Exclude<Facilities['transactional']['phone'], typeof off>`; `Blob` `Awaited<ReturnType<FilesPort['put']>>`;
  `Downloaded` `Awaited<ReturnType<FilesPort['download']>>` (`FilesPort` stays exported); `AiPort` members are
  `Facilities['intelligence']`'s, `EmbeddingsPort` `Exclude<Facilities['intelligence']['embed'], typeof off>`.
  `MembershipPort` reaches no Host API member: `src/lib/services.ts` declares its own port type or drops it.
- `/node`: `DownloadOptions` `NonNullable<Parameters<typeof download_media>[2]>`, `DownloadSink`
  `Parameters<typeof download_media>[1]` (`src/lib/facilities/ports.ts`); `BUNDLER` is internal
  (`src/lib/kernel/bundler.ts` keeps its own limits). The language service is one object, `type_service`
  (`src/lib/lang/type-service.ts`, `src/lib/hosting/studio-lang.ts`, `tests/lang-type-service.test.ts`):
  `type_service.{PROBE, root_of, refresh, filesystem, holder, offset_in, view, check_workspace}`; `Held`
  `ReturnType<typeof type_service.holder>`, `LangPosition` `Parameters<typeof type_service.offset_in>[1]`,
  `LangDiagnostic` `Awaited<ReturnType<ReturnType<typeof type_service.view>['diagnostics']>>[number]`.
- Studio, host side (`/engine` keeps `studio_view`, `StudioPort`, `StudioState`, `StudioInspectInput`): `MigrationImpact` from `/host-api`
  (`src/lib/hosting/{host,ops,recovery-studio,studio-ports,studio-tools,studio,studio-check}.ts`, `src/lib/services.ts`
  and the Studio tests). Derive `StudioFile` `NonNullable<Awaited<ReturnType<StudioPort['file']>>>`, `StudioChangeSet`
  `NonNullable<StudioState['change_sets']>[number]`, `StudioTestRun` `NonNullable<StudioState['tests']>`, `StudioBuild`
  `NonNullable<StudioState['builds']>[number]`, `StudioApproval` `NonNullable<StudioState['approvals']>[number]`,
  `StudioInspection` `Awaited<ReturnType<StudioPort['inspect']>>` (`src/lib/command-center/tenant.ts`).
  `StudioInspectInput` stays a Schema for the command-center filters.
- 0.0.29: import `StudioOp`, `MERGE_SUMMARY`, `suggest_message` and `impact_lines` from `@norbital-ai/bolt/engine` (server-safe; no longer in `/page/studio`) and drop the vite.config workaround that compiled `/page/studio` into the server bundle.
- Studio, browser side (`src/lib/studio/*`, `src/routes/__host/recovery/+page.svelte`, Studio browser tests):
  `StudioPhase` `(typeof PHASES)[number]`; `PhaseState`
  `Extract<Stream.Success<ReturnType<typeof studio_events>>, { kind: 'phase' }>['state']`; `StudioLogLine`
  `StudioView['log'][number]`; `StudioDiagnostic` `NonNullable<StudioView['diagnostics']>[number]`; `StudioRelease`
  `StudioView['releases'][number]`; `StudioChangeSet` `NonNullable<StudioView['change_sets']>[number]`; `StudioTab`
  `StudioProps['tab']`; `StudioMount` is the bundle's own `mount_studio` answer, `{ update(props: StudioProps): void;
  unmount(): Promise<void> }`; `ShellError` (test only) matches by `_tag: 'ShellError'`.
- `language_of` and `elapsed_text` are Colony's display helpers now (`src/lib/studio/{ChangePane,FileDiff,SourceEditor,Studio}.svelte`):
  `language_of(path)` is `'javascript'` for `.[cm]?[jt]s` and `.svelte`, `'json'` for `.json`, else `'plaintext'`;
  `elapsed_text(ms)` is `m:ss` of the rounded seconds.
- One name per Schema value and type: `EngineManifest` (was `EngineManifestSchema`), `DecisionResult`, `GuestTaken`,
  `ArtifactJson` (`/artifact`, was `ArtifactJsonSchema`; `tests/client-cache.test.ts`, `tests/foundation-artifact.ts`),
  `ReadRequestJson` (`/protocol`, was `ReadRequestSchema`). Pure aliases are gone: `/facilities` `Off` is
  `typeof off` (`src/lib/facilities/{ai,ports}.ts`, `src/lib/kernel/cells.ts` and seven tests); `Downloaded` as above.
- One home: `PgliteDb`, `Pristine` and `artifact_port` from `/node` (`tests/hosting-studio-migrations.test.ts`);
  `client_page` and `TemplateManifest` from `/protocol`; `render_mode` and `MigrationImpact` from `/host-api`;
  `ModelLiteral`, `Model`, `Integration` from `/declarations`; `Unavailable` from `/errors`. Root `GeoHit`
  (`src/lib/facilities/geocoding.ts`) is
  `NonNullable<Awaited<ReturnType<Exclude<HostPorts['geocoder'], typeof off>['reverse']>>>`.
- Test-only exports removed from `/engine` (`Invocation`, `Guest`, `GuestConfig`, `GuestLive`, `GuestOptions`,
  `GuestLimits`, `Manifest`, `Telemetry`, `EventIds`, `InvocationEvents`, `Secrets`, `Facilities` (the engine service),
  `AiPort`, `EmbeddingsPort`, `Blob`, `StudioApproval`): `tests/kernel-guest-*.test.ts`, `tests/support/guest-fixture.ts`,
  `tests/hosting-secrets.test.ts`, `tests/hosting-runtime.test.ts`, `tests/facilities-web-read.test.ts` drive the engine
  through `HOST_API` activation or the kit's `test_engine` (`/tooling`), and build local fakes for ports.
