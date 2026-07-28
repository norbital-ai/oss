# Construction Template

Construction project management workspace covering projects, jobs, workers, permits to work, defects, RFIs, payment claims, and a BIM reference matrix for cost and embodied-carbon baselines.

## Layout

Pod discovers the workspace from the filesystem. `vite.config.ts` contains the only root entry point.

```
construction/
├── vite.config.ts         # pod() root entry point
├── src/collections/+relationship.ts
├── src/collections/<name>/
│   ├── +model.ts          # name-free Drizzle model
│   └── +hooks.ts          # optional collection behavior
├── src/apps/**/+<lower_snake_case>.svelte
├── src/automation/+*.ts  # discovered automation declarations
├── src/remotes/+<lower_snake_case>.ts  # optional query and command handlers
└── src/lib/ui/           # tenant-specific UI components
```

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

## Apps

- `construction-project-workspace` — project table with BIM document access, RFIs, defects, financial baselines, and manpower assignments.
- `construction-settings-reference-matrix` — BIM reference matrix admin.
- `construction-settings-workforce` — workers (with permits), certifications, and job requirements.

## Verification

```bash
pnpm --dir template_workspaces/construction run lint
pnpm --dir template_workspaces/construction run build
```

Seed for dev/golden org reset lives in Core (`apps/core/seed/construction/`), not in this template.
