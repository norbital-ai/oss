# @norbital-ai/pod

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
