# @norbital-ai/pod

## 4.0.0

### Minor Changes

- fd8435e: Add app and record-detail banner media with fixed-size fallbacks.

  - `@norbital-ai/pod` compiles a static `pod:banner` from `+representation.svelte` `<svelte:head>` metadata and emits it on the generated collection surface, alongside the existing app `pod:thumbnail` / `pod:banner`.
  - `@norbital-ai/ui` renders the collection banner as a fixed-height image above the record detail sheet header (`CollectionRecordDetailTabs`), and app cards / omni finder keep same-size media slots when no thumbnail exists (16:9 icon tile on cards, fixed 6x6 tile in the finder).

- fd8435e: Add type-safe internationalization for English and Simplified Chinese.

  - `@norbital-ai/std/i18n`: locale parsing and persistence (`parseLocale`, `pickLocale`, `storedLocale`, `storeLocale`, `setHtmlLang`), typed catalogs with compile-time en/zh key parity (`defineMessages`, `translate`, `hasKey`), and the non-reactive `createI18n` runtime for server code.
  - `@norbital-ai/ui/i18n`: reactive Svelte context (`provideI18n`, `useI18n`) with `t`/`has`/`setLocale` and an `intlLocale` derived from the active locale; a `setGlobalLocale` fallback for consumers without a provider; a full en/zh catalog for the component library (`common.*`, `table.*`, `kanban.*`, `form.*`, `dataRenderer.*`, `misc.*`); `locale` props now default to the active locale for date/number/phone formatting.
  - `@norbital-ai/pod/i18n`: the pod chrome and server catalog (`pod.*`, `server.*`, `email.*`, `identity.*`) plus `serverI18n` for server-rendered surfaces (identity pages, transactional email) resolving `?lang=` then `Accept-Language`.
  - Pod compiler: discovers tenant `src/i18n/messages.{en,zh}.json` with structural validation (key parity, JSON shape), generates the typed `TenantI18nKeys` union (`$pod/i18n-keys`), and merges tenant overrides over the platform catalogs at build time (`virtual:pod/i18n`).
  - Pod shell: per-locale sidebar labels via `app.<appId>.title` / `app.<groupId>.title` catalog keys; all platform chrome strings migrated to the catalog.
  - The `authoring-tenant-workspace` skill documents tenant i18n authoring.

### Patch Changes

- Updated dependencies [fd8435e]
- Updated dependencies [fd8435e]
- Updated dependencies [fd8435e]
- Updated dependencies [fd8435e]
- Updated dependencies [fd8435e]
- Updated dependencies [fd8435e]
  - @norbital-ai/ui@4.0.0
  - @norbital-ai/std@4.0.0
  - @norbital-ai/platform-utils@4.0.0

## 3.0.0

### Minor Changes

- d864ec2: The agent composer can reference records: typing `@` opens a keyboard-driven
  menu that searches the workspace's collections and inserts the chosen record as
  an atomic chip.

  The menu searches flat across every non-system collection at once — the local
  replica answers first, with a 150ms debounce and a small per-collection limit —
  and a bare `@` offers the collections as scopes for narrowing the search.
  Arrow keys navigate, Enter or Tab picks, Esc dismisses without touching the
  text, and Backspace on a chip deletes it whole. The draft stays plain text: a
  chip is an `@label` span tracked as a range, and an `@` that never matched — or
  that the writer edited through — goes to the agent as literal prose.

  On send, resolved references ride along as structured mentions. The loop
  fetches each one as the requestor — never elevated, so policy still decides
  what a mention can see — and appends a snapshot to the turn's model window
  only; the stored transcript keeps the clean message the person typed. A
  reference that no longer resolves degrades to a `status` attribute and nothing
  else: the label stays in the message text, so a bad mention costs prose, never
  a failed turn.

### Patch Changes

- d864ec2: Record the budget-exceeding iteration's spend before failing the turn, and quiet the agent composer chrome.

  The agent loop checked its token budget immediately after each provider turn, before the
  iteration's tool-call message (which carries the usage when the turn had no prose) was
  persisted. A turn that died on the budget therefore showed a session total that omitted the
  very spend that exceeded it — a conversation reading "2,018 tokens" next to "budget exceeded
  (12000)". The check now runs after the iteration's usage is persisted, and the error names
  the consumed total (`12,431 of 12,000 tokens`) so the number can be checked against the
  footer.

  The composer textarea no longer draws its focus ring: the editor kept the Textarea's
  `focus-visible` ring, which read as an active border inside the composer card. The editor
  class now overrides the same `focus-visible` variants so tailwind-merge drops them.

  Combobox gains `chevronOnHover` for triggers that read as plain text: the chevron is hidden
  at rest and revealed on hover and focus-within. The workspace agent's conversation picker
  opts in.

- d864ec2: Decide "offline" from whether the server answers, drain the outbox on its own clock, and mark a row that has not committed yet.

  `PodSyncClient.isOnline()` was `navigator.onLine && this.online`, and `setOnline` was defined and
  never called from anywhere but a test — so the whole verdict was `navigator.onLine`. That property
  answers a different question: whether the machine has a network interface it believes is up. A Wi-Fi
  handover, a VPN reconnect or a NIC waking from sleep flips it false for a moment, and any mutation
  landing in that window took the queue branch and came back `OFFLINE_QUEUED` while the server was
  answering every other request perfectly well. Reachability is now observed from real traffic: the SSE
  stream reports whether it could be opened, and every `sync/*` POST reports whether it got an answer.
  A status the server (or its edge) produced counts as reachable however unwelcome it is — only a
  `fetch` that never got an answer, or 408/502/503/504, mean nothing served the request. The device's
  own connectivity events still have a part, and only one direction of it: a browser reporting its radio
  is down marks the server unreachable without spending a request on proving it, and the moment it
  reports back up the outbox drains at once — the attempt itself is the probe that may only then flip
  the verdict back.

  Once queued, the outbox drained in exactly one place: the top of a stream _iteration_, reached only
  when a new SSE connection is established. A healthy feed stays connected for minutes, so a write that
  queued behind one momentary failure sat there until a proxy timed the stream out — the reported
  "it only committed after about a minute". A queued write now schedules its own retry, starting at one
  second and backing off to a ten-second ceiling, and a connection observed to recover drains
  immediately rather than waiting for the next reconnect.

  `sync/*` POSTs carried no deadline, which was worse than it sounds: the stream loop awaited
  `flushPending()`, `stopStream()` awaits the stream loop, and the subscription registry's serialized
  catch-up queue awaits `stopStream()`. One accepted-but-never-answered mutate therefore stalled every
  collection's catch-up behind it, so reads waiting on those collections never resolved, never errored
  and never retried. The drain is now scheduled rather than awaited on the feed's critical path, and
  every request has a 60s ceiling.

  A mutation naming a record whose create is still queued no longer goes to the server for an id the
  server has never seen — the `404 Record with ID … not found` that self-resolved once the outbox
  drained. Create-then-delete on an unsynced row is a no-op and both entries are dropped; an update is
  folded into the create still waiting to be sent; anything else naming a busy record is appended to
  the outbox, which is already ordered and drained in order — and now stamps each entry strictly after
  the one before it, so two writes inside the same millisecond cannot tie and reorder. A delete for an
  id the outbox knows nothing about is still the server's to judge, and still 404s.

  `CollectionTable` marks a row whose write is still in the outbox. It reuses the affordance approval
  already established — a leading border with a `title` and `aria-label`, so the state survives colour
  blindness and a screen reader — in warning amber rather than brand, and takes precedence over
  awaiting-approval because an unsynced row is one the server does not hold at all. It is derived from
  `_pod_pending` itself rather than inferred, so it clears the moment the write settles; a _rejected_
  write is never in this state, because the mutation is rolled back and reported where it was made.

- Updated dependencies [d864ec2]
- Updated dependencies [d864ec2]
- Updated dependencies [d864ec2]
- Updated dependencies [d864ec2]
- Updated dependencies [d864ec2]
- Updated dependencies [d864ec2]
  - @norbital-ai/ui@3.0.0
  - @norbital-ai/platform-utils@3.0.0
  - @norbital-ai/std@3.0.0

## 2.0.0

### Patch Changes

- Updated dependencies [7320705]
  - @norbital-ai/ui@2.0.0
  - @norbital-ai/std@2.0.0
  - @norbital-ai/platform-utils@2.0.0

## 1.0.2

### Patch Changes

- b2e241f: Let Tailwind read Pod's own UI again, which is what put the "Ask agent" button back.

  `app.css` still scanned `./{client,runtime}/**` after those directories became `./ui/**`, so the
  glob matched nothing and no tenant stylesheet carried a utility that only a Pod component uses.
  Anything the shell shares with `@norbital-ai/ui` — the other glob — kept working, which is why the
  workspace looked right and only the odd class went missing.

  The agent launcher was the visible one. It rendered on every workspace and it was `position: fixed`,
  but `bottom-[calc(env(safe-area-inset-bottom)+1rem)]` and `sm:bottom-6` are asked for nowhere else,
  so nothing set `bottom`, and a fixed element with no `bottom` falls back to its static position —
  just past a `h-dvh` shell, 44px below the viewport.
  - @norbital-ai/std@1.0.2
  - @norbital-ai/platform-utils@1.0.2
  - @norbital-ai/ui@1.0.2

## 1.0.1

### Patch Changes

- b846906: Compile `contains_date` and `overlaps` on raw collection `where` objects, and reject unknown filter
  operators with a 400.

  `contains_date` and `overlaps` are Pod's own `dateRange()` operators, not Drizzle's. Only the
  explicit `CollectionFilter[]` controls compiled them; a raw `where` — the shape the authoring skill
  documents for prefilling effective-dated lists to "active now" — passed validation untouched and
  reached Drizzle, whose field-filter compiler calls `operators[key](column, value)` and threw
  `operators[target] is not a function`. The local replica does implement both operators, so the
  optimistic rows rendered and the server round-trip then failed in the UI.

  Raw `where` objects now compile both operators to the same RAW SQL predicate the filter controls
  already produced, at the top level, inside `AND`/`OR`/`NOT`, inside a field-level `AND`/`OR`/`NOT`,
  inside a relation filter object, and inside a nested `with` selection. Any operator key that is
  neither Drizzle's nor Pod's is now a 400 naming the collection, the field, the operator, and the
  accepted set, instead of a `TypeError` from inside Drizzle.
  - @norbital-ai/std@1.0.1
  - @norbital-ai/platform-utils@1.0.1
  - @norbital-ai/ui@1.0.1

## 1.0.0

### Minor Changes

- 41e33b3: Remove `getElevatedApi` from the public `@norbital-ai/pod/authoring` entrypoint, and stop exporting
  `HOST_ROUTE_PREFIX`.

  This is a breaking removal. `getElevatedApi` gave any tenant-authored handler, agent tool, automation
  or hook unrestricted, policy-bypassing read and write on every collection, with no allowlist and no
  system/tenant split — which made workspace source a trust boundary. It was added to unblock a
  template build and is withdrawn rather than kept by default.

  Nothing in `template_workspaces/` or in Core referenced either symbol, so no caller has to change.

### Patch Changes

- 41e33b3: Correct the authoring skill's account of the authored filesystem, and ship the regenerated bundle.

  The tree omitted four roles the compiler fully supports and every template already uses —
  `src/policies/+*.policy.ts`, `src/channels/+*.channel.ts`, `src/+agent.ts` and `src/+env.ts` — and
  stated that "unknown, duplicate, misplaced, or legacy role files are compiler errors", which reads
  far broader than what is enforced: every check keys on a leading `+`, and `src/lib/**` is documented
  free-form helper code.

  That imprecision had a cost. A create surface renamed to a non-`+` file is the rejected call-site
  create API wearing a different filename, and nothing fails the build — which is exactly how one
  shipped. The rules are now stated as what the compiler actually checks, with that consequence
  spelled out.

- 82bc0b2: Mount the billing toast outside Bound so fixed positioning is viewport-relative (not flush against the sidebar), and give it clearer top/right offsets.
- 82bc0b2: Fix MatrixRenderer painting both wide and narrow layouts (scoped CSS on the wrong nodes) and stop unbounded matrices from trapping parent vertical scroll inside forms and sheets.
- 41e33b3: Regenerate the authoring skill bundle so the templates' own representation surfaces are resolvable
  from a template build.
- Updated dependencies [15ccf98]
- Updated dependencies [0bee7b9]
- Updated dependencies [82bc0b2]
  - @norbital-ai/ui@1.0.0
  - @norbital-ai/std@1.0.0
  - @norbital-ai/platform-utils@1.0.0

## 0.0.1

### Patch Changes

- Tenant workspace authoring SDK, runtime, and Vite plugin for Norbital. A host supplies facilities
  over a host-owned stdio channel; the guest serves HTTP inbound and never dials out.
