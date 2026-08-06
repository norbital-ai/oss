# @norbital-ai/ui

## 4.0.0

### Minor Changes

- fd8435e: Add app and record-detail banner media with fixed-size fallbacks.

  - `@norbital-ai/pod` compiles a static `pod:banner` from `+representation.svelte` `<svelte:head>` metadata and emits it on the generated collection surface, alongside the existing app `pod:thumbnail` / `pod:banner`.
  - `@norbital-ai/ui` renders the collection banner as a fixed-height image above the record detail sheet header (`CollectionRecordDetailTabs`), and app cards / omni finder keep same-size media slots when no thumbnail exists (16:9 icon tile on cards, fixed 6x6 tile in the finder).

- fd8435e: Give `Bound` a viewer-fit height contract.

  `size="fit"` renders `h-[min(42rem,calc(100dvh-14rem))] min-h-[28rem]` — a scrollport that claims
  the space below a ~14rem chrome band, capped at `tall` and floored at `standard`. Callers who
  wanted a pane that tracks the viewport had to spell it as arbitrary-value classes on each surface
  (`h-[min(42rem,calc(100dvh-14rem))] min-h-[28rem]` on the workspace settings tables); the contract
  is now named and countable like the fixed sizes, and the three settings tables use it directly.

- fd8435e: Add type-safe internationalization for English and Simplified Chinese.

  - `@norbital-ai/std/i18n`: locale parsing and persistence (`parseLocale`, `pickLocale`, `storedLocale`, `storeLocale`, `setHtmlLang`), typed catalogs with compile-time en/zh key parity (`defineMessages`, `translate`, `hasKey`), and the non-reactive `createI18n` runtime for server code.
  - `@norbital-ai/ui/i18n`: reactive Svelte context (`provideI18n`, `useI18n`) with `t`/`has`/`setLocale` and an `intlLocale` derived from the active locale; a `setGlobalLocale` fallback for consumers without a provider; a full en/zh catalog for the component library (`common.*`, `table.*`, `kanban.*`, `form.*`, `dataRenderer.*`, `misc.*`); `locale` props now default to the active locale for date/number/phone formatting.
  - `@norbital-ai/pod/i18n`: the pod chrome and server catalog (`pod.*`, `server.*`, `email.*`, `identity.*`) plus `serverI18n` for server-rendered surfaces (identity pages, transactional email) resolving `?lang=` then `Accept-Language`.
  - Pod compiler: discovers tenant `src/i18n/messages.{en,zh}.json` with structural validation (key parity, JSON shape), generates the typed `TenantI18nKeys` union (`$pod/i18n-keys`), and merges tenant overrides over the platform catalogs at build time (`virtual:pod/i18n`).
  - Pod shell: per-locale sidebar labels via `app.<appId>.title` / `app.<groupId>.title` catalog keys; all platform chrome strings migrated to the catalog.
  - The `authoring-tenant-workspace` skill documents tenant i18n authoring.

### Patch Changes

- fd8435e: Let `Center` consumer `class` win over the measure token in `twMerge`, so shells like `measure="full" class="max-w-6xl"` actually apply the requested max width.
- fd8435e: Fix collection table select-all alignment, hide column sort controls after resize unless hovered or active, and open the record sidesheet only from the row expansion action (with a bordered background).
- Updated dependencies [fd8435e]
- Updated dependencies [fd8435e]
  - @norbital-ai/std@4.0.0
  - @norbital-ai/platform-utils@4.0.0

## 3.0.0

### Minor Changes

- d864ec2: Let a `CollectionTable` view open on a filter the operator can remove.

  An effective-dated list wants to open on what is in force today without hiding
  that it has done so. Neither existing channel could express that. A condition in
  `query.where` is applied invisibly and cannot be cleared — the "Applied by this
  view" tooltip can only narrate it after the fact — so surfaces grew a bespoke
  "In force today / All history" `ToggleGroup` beside the table instead: a second
  filter control, sitting next to the real one, for one hard-coded condition.

  `initialFilters` seeds the filter builder itself. Each entry becomes an ordinary
  row in the popover — same field picker, same operator list, same operand editor,
  same `x` — so the default is visible where every other condition is, counts
  toward the filter button's active badge, and can be edited or dropped.

  Clearing a seed is remembered against the table's `view`. Interactive filters are
  deliberately not persisted, so without that the seed would return on every reload
  no matter how often it was dismissed. What persists is the _signature_ of the
  cleared seed rather than a bare flag, so an author who later changes the default
  gets the new one applied instead of it staying suppressed by a decision taken
  about a different condition.

  The seed is written in the builder's vocabulary, not the wire's: `field` is the
  path the field picker uses, and `value` is what its operand editor produces — a
  calendar day for `contains_date`, which `collectionFilterClause` converts to an
  instant on the way out. Seeding wire shapes would have meant reversing that
  conversion and unwrapping the `%…%` an `ilike` operand is published with.

  `query.where` remains the right home for scoping a view is not entitled to widen,
  such as the legal entity it belongs to.

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

- d864ec2: Constrain and compact the collection form field-history popover.

  The popover grew unbounded and overflowed the viewport. Its `max-h-64` (and the
  `max-h-32` on each value) were passed to `Scroll`, which composes classes as
  `cn(className, ...)` — so `tailwind-merge` dropped both in favour of the
  primitive's own `max-h-full`. With no height cap, Floating UI could not contain
  it: `flip`/`shift` only reposition the content, and the `size` middleware just
  publishes `--bits-floating-available-height` without applying it. The height cap
  now lives on the tooltip content itself, where it survives class merging, and
  the scroll region fills it.

  Each revision is now a single dense line — value plus timestamp — instead of a
  bordered card wrapping a `StructuredValue` table, which removes the nested
  borders and the horizontal scrollbar. Revision timestamps use the day-month-year
  convention (`05 Aug 2026, 14:32`) and resolve in the viewer's timezone.

  `Tooltip` also forwards `avoidCollisions` and `collisionPadding` (defaulting to
  `true` and `8`), matching `Combobox`; Bits UI otherwise leaves collision padding
  at `0`.

- Updated dependencies [d864ec2]
- Updated dependencies [d864ec2]
  - @norbital-ai/platform-utils@3.0.0
  - @norbital-ai/std@3.0.0

## 2.0.0

### Minor Changes

- 7320705: Combobox: expose viewport clamping for the dropdown, and give the chevron its own chrome.

  `avoidCollisions` (default `true`) and `collisionPadding` (default `8`) are now forwarded from
  `Combobox` to the underlying floating primitive. When enabled, the dropdown flips its side and
  shifts its alignment to stay clamped inside the viewport instead of spilling past an edge, and it
  re-evaluates on scroll and resize rather than only when it opens. Both defaults match the previous
  behaviour, so existing call sites are unaffected; pass `avoidCollisions={false}` to pin the
  dropdown to `align` exactly.

  `snapToEnds` is now deprecated. It re-implemented the same clamping by guessing the dropdown width
  once at open time, which the primitive already does continuously and with real measurements. It
  still works and still defaults to `false`; remove it in favour of `avoidCollisions`.

  The trigger chevron now renders as a small rounded control that gains a background and an outline
  on hover and on focus-within. The glyph itself stays visible at rest, so the "this is a dropdown"
  affordance is never hover-only for keyboard and touch users.

### Patch Changes

- @norbital-ai/std@2.0.0
- @norbital-ai/platform-utils@2.0.0

## 1.0.2

### Patch Changes

- @norbital-ai/std@1.0.2
- @norbital-ai/platform-utils@1.0.2

## 1.0.1

### Patch Changes

- @norbital-ai/std@1.0.1
- @norbital-ai/platform-utils@1.0.1

## 1.0.0

### Minor Changes

- 15ccf98: Type `CollectionForm` `Field` so each usage infers `rendererProps` from the chosen `renderer`. Required renderer props (for example `RelationshipRenderer`'s `target`) are enforced, and nested callbacks such as `options.label` infer their record parameter without `satisfies CollectionRelationOptions`. Removes the open index signature on `CollectionFormRendererOptions` that previously collapsed that inference.

### Patch Changes

- 0bee7b9: Fix the day and week calendar views importing `#lib/utils/pixel-drag.js` with an extension the `#lib/utils/*` subpath appends itself, which resolved to `pixel-drag.js.js` and failed any build that reached the event calendar.
- 82bc0b2: Fix MatrixRenderer painting both wide and narrow layouts (scoped CSS on the wrong nodes) and stop unbounded matrices from trapping parent vertical scroll inside forms and sheets.
  - @norbital-ai/std@1.0.0
  - @norbital-ai/platform-utils@1.0.0

## 0.0.1

### Patch Changes

- Svelte component library and design tokens for Norbital tenant applications.
