# BCA Field Operations

BCA manages field-service work from scheduled site job through contractor dispatch, field progress,
variation request, and evidence capture. It is a deliberately focused construction-operations template:
it does not attempt to be a project-costing or payroll system.

For the template’s goal, users, and extension boundaries, see the [BCA documentation hub](./docs/README.md).

## Operating flow

1. Create a **site** with client, property, and optional geolocation context.
2. Schedule a **job** for that site, then declare its required certifications.
3. Register a contractor profile and its certification holdings.
4. Dispatch the contractor through a **job assignment**. Pod rejects an assignment when the contractor
   lacks a required certification, the job is already assigned, or the source message was processed before.
5. The contractor records progress and an optional site location. A recorded point more than 500 metres
   from the site flags the assignment for review; completing it timestamps the assignment and advances the
   job state.
6. Capture photos against exactly one assignment or variation. The workspace records image fingerprints
   and integrity flags, then surfaces exact and near-duplicate matches.
7. Raise a **variation request** when work departs from scope. Its approval and audit lifecycle is owned
   by the platform’s native approval system, not by tenant columns.

## Collections and relationships

| Collection                       | Purpose and important rule                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `sites`                          | Physical site, client/property context, and optional map location. Historical jobs remain attached to the site. |
| `jobs`                           | Work scheduled for one site. It begins `unassigned` and follows assignment progress.                            |
| `certification_types`            | Qualification catalogue used by jobs and contractors.                                                           |
| `job_certification_requirements` | Join table for the qualifications required by each job.                                                         |
| `contractor_profiles`            | Contractor organisation linked one-to-one with its tenant user.                                                 |
| `contractor_certifications`      | Join table for a contractor’s qualification holdings.                                                           |
| `job_assignments`                | One contractor per job. Identity cannot be moved after dispatch; location can flag the assignment.              |
| `variation_requests`             | Scope-change request for an assignment. Duplicate source-message keys are rejected.                             |
| `photo_evidence`                 | Image evidence attached to exactly one assignment or variation, with deterministic integrity results.           |

```text
site → jobs → job assignment ← contractor profile
             ↓                  ↑
  required certifications     certifications held
             ↓
       photo evidence ← variation request
```

## Apps and server behaviour

| Surface                | Audience                      | What it provides                                                                                          |
| ---------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `bca_controller`       | Dispatch and operations staff | Day schedule, sites, jobs, contractors, certification management, and assignment oversight.               |
| `bca_contractor`       | Field contractor              | Assigned work, site locations, progress, evidence, and field activity.                                    |
| `bca_dashboard` remote | Controller app                | A date-specific assignment list and site map points; it joins jobs, contractors, and sites on the server. |

The domain rules live in collection hooks, so they apply to every client and remote—not only the UI:

- A job must reference an existing site.
- An assignment must reference an existing job and contractor, be unique per job, and meet all declared
  qualification requirements.
- `source_message_id` is an idempotency key for inbound assignments and variations.
- A completed assignment receives `completed_at`; assignment state keeps its job state in sync.
- Photo evidence accepts only JPEG or PNG, requires exactly one parent, records SHA-256 and perceptual
  hashes, and marks exact/visual duplicates or image metadata-quality anomalies.

## Maps and files

The dispatch schedule uses Pod’s host-provided static-map facility. Map provider credentials and file
storage remain in the host adapter; they are never embedded in this workspace or sent to browser code.
Photo evidence stores a selected file asset and its derived fingerprints, not a source conversation or
unselected media.

## Source map

```text
src/apps/                         controller and contractor applications
src/collections/                  domain models, relationships, hooks, and representations
src/collections/photo_evidence/lib/  image inspection and parent validation
src/custom-types/                 money and evidence-source types with renderers
src/lib/certification-eligibility.ts  dispatch qualification checks
src/remotes/+bca_dashboard.ts     date-based controller dashboard query
```

## Verify and deploy

```bash
pnpm --dir template_workspaces/bca sync
pnpm --dir template_workspaces/bca lint
pnpm --dir template_workspaces/bca build
```

`sync` may update `.norbital/migrations/`; commit that history with the authored change. Publish the
template, then deploy a new tenant checkpoint to make a revision available to a tenant. See the
[template lifecycle](../README.md#release-and-tenant-lifecycle) and [Pod overview](../../packages/pod/docs/OVERVIEW.md).
