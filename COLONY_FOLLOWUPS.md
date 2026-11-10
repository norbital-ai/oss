# Colony follow-ups

- Update host code that inspects policy grants for the output-scoped read and history metadata. Ship the new compiled bundle and shell together.

- Update the host and cell loader together for Host API 17. The database port has no interactive session lease, and `CELL_ABI_VERSION`, `Kernel` and `CellEnd` are exported from `@norbital-ai/bolt/host-api`.
- Remove the speech capability from host facilities and retire its provider configuration. Keep Convert for transcription.
- Before activating the release, migrate declared envoy defaults into `sys_envoy` and update references to the resulting UUIDs. Preserve policies, task, delegation, audience, group handling, DM mode and triage scope.
- Activate the shell and engine together because the Studio manifest view no longer includes `remotes`.
- Drop the retired `bolt_run_admitted` table during cutover after verifying every serving release has stopped using it.
- Coordinate the agent browser’s read-on-inspection change with the removal of `window.boltLivePoll`. The remaining page SDK fallback supports the current host.

- Read kiosk declarations from manifest apps whose `shell` is `kiosk`. Keep serving their existing route namespace with the new shell and release.
- Session authentication now reads the active session from the database on each request so revocation applies across activations. Account for this in the host's request and database-wake measurements.
