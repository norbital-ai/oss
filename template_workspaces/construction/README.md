# Construction Template

![Construction workspace thumbnail](assets/thumbnail.svg)

Construction project management workspace covering projects, jobs, workers, permits to work, defects,
RFIs, payment claims, and a BIM reference matrix for cost and embodied-carbon baselines. It provides the
operations model and safety checks for project delivery; it does not replace an ERP, a BIM authoring
tool, or a regulatory permit authority.

For the template’s goal, users, and extension boundaries, see the
[Construction documentation hub](./docs/README.md).

## Operating model

1. Establish a **project**, its site locations, and BIM reference context.
2. Configure certification types and active permits for the workforce.
3. Define jobs, link them to their work fronts and certification requirements, then create compliant
   worker assignments.
4. Run delivery in the project workspace: track RFIs, defects, associated files, and job status.
5. Track commercial work through payment claims and preserve the documents supporting each claim.
6. Review the scheduled daily operational exports for permits, defects, RFIs, and claim readiness.

The data model keeps these concerns separate: jobs describe work packages; site locations describe work
fronts; permits prove a worker’s currently valid authority; and assignments connect a worker to work only
after the compliance check passes.

## Layout

Pod discovers the workspace from the filesystem. `vite.config.ts` contains the only root entry point.

```
construction/
├── vite.config.ts         # pod() root entry point
├── src/collections/+relationship.ts
├── src/collections/<name>/
│   ├── +model.ts          # name-free Drizzle model
│   └── +hooks.ts          # optional collection behavior
├── src/apps/+<lower_snake_case>.svelte
├── src/policies/+<lower_snake_case>.policy.ts
├── src/automation/+*.ts   # discovered automation declarations
├── src/custom-types/<name>/  # +definition.ts and +renderer.svelte
└── src/lib/ifc-viewer/    # the embedded IFC viewer and its converter worker
```

This template declares no remotes: every surface it needs is a live collection query, and the daily
watches are automations rather than request/response handlers.

## Collections

| Collection                            | Purpose                                                           |
| ------------------------------------- | ----------------------------------------------------------------- |
| `projects`                            | Construction projects and operating context.                      |
| `jobs`                                | Work packages linked to site locations and BIM references.        |
| `workers`                             | Worker roster used for assignment and compliance.                 |
| `certification_types`                 | Certification library defining workforce requirements.            |
| `site_locations`                      | Work fronts and delivery zones within a project.                  |
| `defects`                             | Quality issues and closeout items.                                |
| `rfis`                                | Design and coordination questions.                                |
| `payment_claims`                      | Commercial claims with readiness and submission state.            |
| `permits_to_work`                     | Permit and competency validity records.                           |
| `asset_documents`                     | Handover and asset-linked documents.                              |
| `bim_reference_matrix`                | BIM item master sheet for cost and carbon estimation.             |
| `job_assignments`                     | Worker assignments to jobs and site locations (compliance-gated). |
| `jobs_certification_types`            | Join: jobs ↔ certification_types.                                 |
| `jobs_site_locations`                 | Join: jobs ↔ site_locations.                                      |
| `permits_to_work_certification_types` | Join: permits_to_work ↔ certification_types.                      |
| `permits_to_work_workers`             | Join: permits_to_work ↔ workers.                                  |

## Relations

- `permits_to_work` ↔ `certification_types` and ↔ `workers` (M2M through join tables).
- `jobs` ↔ `certification_types` and ↔ `site_locations` (M2M through join tables).
- `job_assignments` → `workers` / `jobs` / `site_locations` (direct FK one-relations; back-references on the parent tables).

## Job assignment compliance

`job_assignments/+hooks.ts` validates create/update assignments:

1. Load the worker's active permits (via `permits_to_work_workers` + `permits_to_work`) and collect covered certification ids.
2. Load jobs linked to the assignment's site location (via `jobs_site_locations` + `jobs` with required certifications).
3. Require at least one site job whose required certifications are all covered by an active, in-validity permit.

This is enforced in both create and update hooks, not just in the assignment UI. Empty requirements do
not pass the guard: every assignment requires a site-location job with an explicit qualification set.

## Daily operational watches

The following server automations run at `06:00` each day. They produce bounded JSON exports for
operational review; they do not send messages, escalate records, or mutate business state.

| Automation                      | Subject           | Export file                          |
| ------------------------------- | ----------------- | ------------------------------------ |
| `permit_expiry_watch`           | `permits_to_work` | `permit-expiry-watch.json`           |
| `defect_closeout_digest`        | `defects`         | `defect-closeout-digest.json`        |
| `rfi_followup_watch`            | `rfis`            | `rfi-followup-watch.json`            |
| `payment_claim_readiness_watch` | `payment_claims`  | `payment-claim-readiness-watch.json` |

All four share one shape: read at most 250 rows, report that number as the summary count, and export
the first 25 as the file body. Two different bounds because they answer two different questions — a
reviewer wants a sense of scale and a handful of rows to look at, not a full table in a JSON blob.
The consequence to know is that the summary count saturates at 250, so it is a floor once a subject
grows past that, not a total.

If a deployment needs alerts, an integration or delivery facility must be added explicitly; do not assume
these read-only watches notify anyone on their own.

## Apps and policies

| App                                      | Tabs                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `construction_project_workspace`         | Projects, RFIs, defects, payment claims, BIM references, and job assignments |
| `construction_settings_workforce`        | Workers, certification types, and job requirements                           |
| `construction_settings_reference_matrix` | The BIM reference matrix on its own                                          |

Those tabs are the tables, not the whole surface. A project's own record carries the depth: its
representation opens the IFC viewer and the asset documents, and gathers the permits, RFIs, defects
and claims that belong to that project. Site locations, asset documents and permits to work have no
tab of their own anywhere and are reached only that way — through the project, which is the only
context in which any of them means much.

Three policies match those three apps one for one, and their grant sets are identical: unconditional
read on the same twelve collections. The narrowing is `apps`, not `where`. That is deliberate rather
than lazy — construction carries no requestor-bearing column on any of these collections, so there
is nothing for a `where` clause to scope to, and what actually separates a delivery user from a
settings administrator is which application they can open.

The three files repeat the twelve grant lines instead of sharing a list, because `src/policies`
admits only `+<name>.policy.ts`; a `collections.ts` beside them is a compiler diagnostic, not a
module. Twelve literal lines per file is the price of keeping a policy's whole grant set readable in
the file that names it.

## Source map and extension points

```text
src/apps/                              project and settings applications
src/policies/                          one read-only role per application
src/collections/                       models, relationships, hooks, and representations
src/automation/                        daily review exports
src/custom-types/                      money, address, coordinates, contacts, and permit signatures
src/lib/ifc-viewer/                    IFC conversion worker and in-app viewer
```

Use collection hooks for non-negotiable server rules, a custom type when a reusable field needs its own
validation and renderer, and a collection representation only when schema-derived UI is insufficient.
Keep large BIM artefacts in a file-storage facility; the `bim_reference_matrix` is the reference and
baseline model, not a replacement for native BIM files.

## Verification

```bash
pnpm --dir template_workspaces/construction sync
pnpm --dir template_workspaces/construction run lint
pnpm --dir template_workspaces/construction run build
```

`sync` may create or update `.norbital/migrations/`; commit that migration history with the authored
change. Publish a template revision and deploy a new tenant checkpoint before expecting an existing
tenant to use it. See the [template lifecycle](../README.md#release-and-tenant-lifecycle).
