---
name: bolt-primer
description: How a Bolt workspace works and everything the platform already renders, so a change reuses it instead of rebuilding it.
---
## The workspace
Everything is source under src/; a `+` file is a compiler role and its path is its name. +workspace.ts (zone, locale,
connections); data/model/<name>/+model.ts with +representation.svelte (that model's record sheet);
data/custom_field/<name>/+definition.ts (+renderer.svelte); access_control/policy/+<name>.policy.ts and team/+team.ts;
integration/<name>/+integration.ts (+integration.svelte); agent/+agent.md, envoy/+<id>.envoy.ts, skill/<name>/+skill.md;
automation/+<name>.automation.ts; app/<app>/+app.ts with +<page>.page.svelte (`import { bolt } from '$bolt'`);
kiosk/<k>/+kiosk.ts; i18n/+messages.ts and +<locale>.messages.ts. Anything without `+` is an ordinary module
(src/lib). .norbital/ is generated. The preview build writes the next migration into the change: never hand-write one.
Before writing, read a sibling that already does the same thing, and the docs tool for the exact API.

## What the platform renders: never rebuild it
- Table `of` a model: the toolbar (title, ⓘ description, search, filter and sort, column menu, CSV export, the ⚡
  actions menu, New), selection with bulk update and delete, cursor paging with its footer, empty states, approval
  accents, and the record sheet when a row opens. Search appears when the model declares search.text: never add a
  search box. `where` is the fixed scope, `initialFilter` a filter the viewer can clear. Columns render by kind, a
  link column shows the linked row's label; a `cell` snippet only for a value computed for display.
- The ⚡ menu offers the model's file syncs (Import, Download template, Export), Sync now, Update and Delete selected;
  `toolbar.actions` adds page operations (`{ icon, name, description, run, requiresSelection? }`): the menu shows
  their spinner, outcome and run. Never add buttons around a view.
- CustomView draws any other body over rows with the same toolbar (`model` adds that model's syncs and New); Board,
  Map, Pivot, Matrix, EventCalendar and Chart take the same toolbar.
- AppShell: icon, title, description render the page hero once; its `actions` snippet is the page scope (company,
  site, period, month): one set of pickers in the header that every view of the page reads. Never put a scope picker
  in a toolbar or above a view. The app's pages come from +app.ts `pages`; Tabs only split one page's sub-views.
- Record sheet: RecordShell renders the representation (Form, Section, Field) with the state pill, lock banner,
  approval panel (approve, reject, request changes; Resubmit), history with restore, and runs. Grants, state edges,
  enum transitions, locked, check and noOverlap are enforced and shown: never re-check them in a form. readonly shows
  a value as text; disabled keeps the editor visible but inert.
- Every field kind renders and edits itself in cells, forms and history: text formats (email, phone, url, markdown,
  zone), money, numbers, dates and periods, enum and state words (i18n `models.<m>.fields.<f>.<value>`), files with
  previews, points with maps, links as pickers of readable rows, typed json. Never map labels by hand, never show an id.
- The shell owns the inbox (approvals), notifications (a model's notify), Settings (people, organisation, audit,
  automation runs, integrations, secrets), the finder (models with search.text), Studio and kiosks.
- An integration's +integration.ts is its driver; the generic setup renders pairing, test, reconnect and disconnect,
  so +integration.svelte only when setup truly differs. Instances are sys_integration rows.

## A capability the workspace lacks
An outside API (transcription, translation, a vendor's catalogue) is source, never a pasted key: an http integration
(integration/<name>/+integration.ts, driver 'http', its base URL and auth) holds the credential the person enters when
they set its instance up in Settings → Integrations, and an automation with typed inputs calls it through ctx.request;
agents then start that automation. A key the code itself needs (an OAuth client, an MCP token) is declared in
src/+secrets.ts and its value entered in Settings → Secrets. Never ask for, accept or write a key in chat or source.
A procedure worth repeating is a skill (agent/skill/<name>/+skill.md, with scripts run_js runs as written).

## A page, always the same shape
AppShell (identity; page scope in `actions`) → one view of the subject model scoped by `where` from that scope,
toolbar title of 1–3 words and its purpose in description → page operations in toolbar.actions, row operations in
row actions, record operations in the record sheet. No heading that repeats the hero, no paragraph or button row
above a view, no hand-made search, filter, paging, export or empty state. Data: one bolt.query per view with its
layers (never a read per row, never $effect to fetch); materialise time with bolt.clock before it enters a query.
