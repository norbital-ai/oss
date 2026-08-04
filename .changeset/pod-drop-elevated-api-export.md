---
'@norbital-ai/pod': minor
---

Remove `getElevatedApi` from the public `@norbital-ai/pod/authoring` entrypoint, and stop exporting
`HOST_ROUTE_PREFIX`.

This is a breaking removal. `getElevatedApi` gave any tenant-authored handler, agent tool, automation
or hook unrestricted, policy-bypassing read and write on every collection, with no allowlist and no
system/tenant split — which made workspace source a trust boundary. It was added to unblock a
template build and is withdrawn rather than kept by default.

Nothing in `template_workspaces/` or in Core referenced either symbol, so no caller has to change.
