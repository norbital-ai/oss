# Field Operations

![Field Operations workspace banner](assets/banner.svg)

Field Operations manages field-service work from scheduled site job through contractor dispatch, field progress,
variation request, and evidence capture. It is a deliberately focused construction-operations template:
it does not attempt to be a project-costing or payroll system.

For the template’s goal, users, and extension boundaries, see the [Field Operations documentation hub](./docs/README.md).

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

| Surface                      | Audience                      | What it provides                                                                                                                                                                  |
| ---------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `field_ops_controller`       | Dispatch and operations staff | A dated dispatch schedule as a status kanban beside a site map, sheets to create a job and assign a contractor, and tabs for sites, contractors, and the certification catalogue. |
| `field_ops_contractor`       | Field contractor              | One table of its own assignments: job, site, dispatch time, status, reported location, and summary.                                                                               |
| `field_ops_dashboard` remote | Controller app                | A date-specific assignment list and site map points; it joins jobs, contractors, and sites on the server.                                                                         |

Both apps are deliberately thin, because the work happens inside a record rather than across a table.
Opening an assignment brings up its variations and its photo evidence together; opening a site
separates the jobs still ahead of it from the ones already done. Putting those on the assignment and
the site — instead of giving evidence and variations top-level tabs — keeps a contractor from ever
having to answer "which job was this photo for" from a list.

Two policies back those apps. `field_ops_controller` opens both applications, because a controller
who cannot see the contractor's own view cannot help someone stuck in it. `field_ops_contractor`
opens only the contractor app and scopes every grant to the requestor: its own profile, its own
certifications, the sites and jobs it is actually assigned to, and nothing else. Scoping is done with
`where` clauses rather than by hiding tables, so the same limits hold for a remote or an agent, not
only for a screen.

The variation approval flow is declared there too, on the contractor's `create` grant for
`variation_requests` — a scope change is a commercial decision, so writing one raises a request
rather than a row, and a controller review step resolves it. The approver is named by team name
rather than by team id, because a team is a runtime row: an id belongs to whichever database seeded
it, so hardcoding one would put a private identifier in a public template and leave the flow
unsatisfiable anywhere else.

The domain rules live in collection hooks, so they apply to every client and remote—not only the UI:

- A job must reference an existing site.
- An assignment must reference an existing job and contractor, be unique per job, and meet all declared
  qualification requirements.
- `source_message_id` is an idempotency key for inbound assignments and variations.
- A completed assignment receives `completed_at`; assignment state keeps its job state in sync.
- Photo evidence accepts only JPEG or PNG, requires exactly one parent, records SHA-256 and perceptual
  hashes, and marks exact/visual duplicates or image metadata-quality anomalies.

## Maps and files

The dispatch schedule plots its site markers with `StaticMap` from `@norbital-ai/ui`, which loads
Leaflet in the browser and draws OpenStreetMap tiles. No map provider credential appears anywhere in
this workspace, and none is required: a dispatch map answers “are these jobs where I think they are”,
which a keyless tile source answers perfectly well, and a fresh tenant should not need an account
with a map vendor before its first screen will render. A tile that fails to load says so in place
rather than leaving a blank panel.

File storage remains the host's. Photo evidence stores a selected file asset and its derived
fingerprints, not a source conversation or unselected media.

## Source map

```text
src/apps/                         controller and contractor applications
src/policies/                     the two roles, their scoping, and the variation approval flow
src/collections/                  domain models, relationships, hooks, and representations
src/collections/photo_evidence/lib/  image inspection and parent validation
src/custom-types/                 money and evidence-source types with renderers
src/lib/certification-eligibility.ts  dispatch qualification checks
src/lib/calendar.ts               the calendar date of an instant in a named timezone
src/lib/instant-format.ts         instants rendered for a Singapore-local reader
src/remotes/+field_ops_dashboard.ts     date-based controller dashboard query
```

The two date helpers are separate on purpose. Deciding which day an assignment belongs to is a
scheduling question the dashboard must answer identically wherever it runs, while presenting an
instant to a reader is a display question — folding them together is how a schedule ends up shifting
with the viewer's browser.

## Verify and deploy

```bash
pnpm --dir template_workspaces/field-operations sync
pnpm --dir template_workspaces/field-operations lint
pnpm --dir template_workspaces/field-operations build
```

`sync` may update `.norbital/migrations/`; commit that history with the authored change. Publish the
template, then deploy a new tenant checkpoint to make a revision available to a tenant. See the
[template lifecycle](../README.md#release-and-tenant-lifecycle) and [Pod overview](../../packages/pod/docs/OVERVIEW.md).
