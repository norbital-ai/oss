# Bolt cutover preparation

Use this checklist against a restored copy of a tenant. Record the old release, snapshot and
schema fingerprint with the rehearsal results. Use an in-place upgrade for Colour Matching and
keep its records, history, attachments and existing connection references in the verification set.

## Before pausing

1. Inventory all running releases that use the tenant database. Record each release's manifest,
   schema fingerprint, pending approvals, queued and running jobs, and the last delivered outbox
   item for each active connection.
2. Compare each source envoy name with runtime `sys_envoy` rows and each distinct envoy reference
   in `sys_integration.envoy` and `sys_conversation.envoy`. Prepare an explicit source-name-to-UUID
   mapping. Preserve references that already point to the intended active or inactive runtime row.
   Check unresolved or ambiguous references before applying the migration.
3. Plan the storage migration against the copied database. Review the schema plan, data changes,
   ownership and rollback together. Capture the shell release and host ABI with the engine release.

## Rehearsal

1. Pause admissions and drain in-flight work. Take the checkpoint after the final write, before
   applying a schema or data change.
2. Add the new `sys_envoy` fields with the release migration. For each source envoy being kept,
   insert or select its runtime row using the prepared mapping. Carry over display name, task,
   policies, delegation, audience, group handling and DM mode. For triage, map the former scope to
   `triage: true` and `triage_scope` of `dm`, `group` or `all`. Update the matching connection and
   conversation references together. Keep the settings of pre-existing runtime rows.
3. Check that every legacy reference that was mapped now points to the intended UUID, and that
   public and private conversations retain their visibility for staff, the owner and outside
   senders. Inspect pending approvals and connection delivery state before enabling workers.
4. Inventory persisted structured decisions, outcomes and actor metadata before renaming their
   keys and values. The standalone and scoped audit bundles include `0004_authoring_names.sql`.
   Each migration takes an exclusive event-table lock, disables the immutable trigger, rewrites
   only root status `pendingApproval` and actor kind `apiKey`, validates the updated check and
   restores the trigger in the same transaction. Apply it with the migration owner after pausing
   writers. Verify payload text and immutable-row enforcement afterward. Other stored payload
   formats need their own schema-aware migration for `requestChanges` and `uncompatible`.
5. Keep each history row's schema association. Stamp rows only when the version's field mapping
   is known. For rows that require expiry, record the affected models, revisions and retention
   decision first. Inspect legacy audit receipts and apply the supported adoption procedure or
   record the agreed expiry. Re-sealing browser profiles belongs to the host.
6. Drop `bolt_run_admitted` after draining and confirming all serving code has released it. Run
   the drop with the release's schema migration and verify the next plan is empty.
7. Boot the new shell, host and engine together. Verify sign-in, ordinary and held writes, run
   admission and completion, history restore, public pages, and an already linked envoy. Check the
   copied Colour Matching records, history and file bytes against their pre-cutover samples.
8. Rehearse failure after pause. Inject a migration failure, restore the checkpoint as required,
   reopen the old release and verify data, writes and reads through the old release. Record the
   commands, affected rows and recovery time for the host operator.

Tenant rollout needs the final release's migration bundle and the host steps in
`COLONY_FOLLOWUPS.md`. Rehearsal and rollout are pending.

Rebuild schema objects whose own-row predicates use `like`. They now match case-insensitively
like reads. Review any affected checks and partial unique indexes against a tenant copy before
applying the generated migration.

The record-label cut generates label and search columns for system models that previously used
field-list labels. Include those objects in the release migration and rebuild their text indexes.
Field descriptors use `many`, `ref`, and the new list-bound keys in manifests and JSON shape checks.
Regenerate those schema checks from the final manifest before preparing the immutable bundle.

Many-valued text and enum fields use native `text[]`. For columns that formerly stored a
list in JSONB, include an explicit conversion in the reviewed migration. Use
`ARRAY(SELECT jsonb_array_elements_text(value))` for non-null arrays, preserving SQL NULL
where the field is optional. Rebuild state guards and dependent indexes after the type change.
Rehearse this conversion on the copied tenant before sealing the final migration bundle.
