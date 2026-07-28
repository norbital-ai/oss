# BCA Template

Day job dispatch: sites → jobs (nature → required quals) → qualified contractor assignments.
Assignments carry progression, photos (duplicate checks), and variations.

## Collections

| Collection            | Purpose                                       |
| --------------------- | --------------------------------------------- |
| `sites`               | Tenant, dwelling type/size, location          |
| `jobs`                | Day work unit with certification requirements |
| `contractor_profiles` | Company + certifications                      |
| `job_assignments`     | Dispatch + progression                        |
| `variation_requests`  | Scope change on an assignment                 |
| `photo_evidence`      | Image + integrity flags (hash / near-dup)     |

## Apps

- `bca_controller` — dispatch schedule, sites, and contractor management
- `bca_contractor` — own assigned jobs, locations, and captured field activity

## Google Maps

The dispatch schedule requests Pod's host-provided Static Map facility. Provider credentials belong
to the host adapter; tenant workspace source and browser JavaScript never receive them.

## Verify

```bash
pnpm --dir template_workspaces/bca run lint
pnpm --dir template_workspaces/bca run build
```
