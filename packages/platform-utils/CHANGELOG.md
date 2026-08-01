# @norbital-ai/platform-utils

## 0.0.12

### Patch Changes

- 89ca704: Project a collection-event automation's trigger into the workspace manifest.

  `ManifestAutomationTemplate` carries `cron_schedule` so a host can schedule a timed automation from
  the manifest alone. An automation declared with `{ trigger: { collection, event } }` had no manifest
  representation at all, so a host could not tell that a tenant needed its change feed drained — which
  is how that form came to be declared, typed, compiled, and never run on the hosted platform.

  `event_trigger` is that representation. A host subscribes only the tenants that declare one, rather
  than draining every tenant on a timer.

## 0.0.1

- Initial baseline release of the tenant build, checkpoint, storage, and authoring contracts.
- Checkpoint identities use the tenant tree hash plus the build pipeline generation. What a build compiled against lives in the tenant's own committed `pnpm-lock.yaml`.
- Browser-safe authoring gateways keep server-only storage out of client bundles.
