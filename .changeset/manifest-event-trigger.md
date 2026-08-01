---
'@norbital-ai/platform-utils': patch
---

Project a collection-event automation's trigger into the workspace manifest.

`ManifestAutomationTemplate` carries `cron_schedule` so a host can schedule a timed automation from
the manifest alone. An automation declared with `{ trigger: { collection, event } }` had no manifest
representation at all, so a host could not tell that a tenant needed its change feed drained — which
is how that form came to be declared, typed, compiled, and never run on the hosted platform.

`event_trigger` is that representation. A host subscribes only the tenants that declare one, rather
than draining every tenant on a timer.
