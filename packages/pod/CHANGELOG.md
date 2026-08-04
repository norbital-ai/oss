# @norbital-ai/pod

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
