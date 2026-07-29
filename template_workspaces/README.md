# Template workspaces

Shipped starter workspaces live in this directory. Each is a standalone filesystem-first Pod
project that can be synchronized, checked, built, migrated, and seeded with the public Pod CLI.

| Template                            | Directory       | Purpose                                                                  |
| ----------------------------------- | --------------- | ------------------------------------------------------------------------ |
| [**hr-payroll**](./hr-payroll/)     | `hr-payroll/`   | Multi-country HR and payroll with effective-dated facts and payroll runs |
| [**construction**](./construction/) | `construction/` | Project-centered construction ops with BIM and workforce compliance      |
| [**bca**](./bca/)                   | `bca/`          | Site operations: contractor visits, variation approvals, photo integrity |
| [**crm**](./crm/)                   | `crm/`          | Customer relationship management with pipelines and activity tracking    |
| [**reclamation**](./reclamation/)   | `reclamation/`  | Survey documents stitched into a 3D site solid and priced from a matrix  |

## Choosing a template

- **BCA Field Operations** is the focused choice for day-of-work dispatch, qualification checks,
  site evidence, and variation requests.
- **Construction Operations** covers wider project delivery: workforce permits, quality, RFIs,
  BIM references, payment claims, and scheduled operational watches.
- **CRM** covers customer accounts, quoting, customer-specific pricing, order fulfilment, payments,
  and sales activities.
- **HR & Payroll** is the specialised multi-country payroll workspace, including attendance, leave,
  statutory contribution configuration, and reconciliation guidance.
- **Reclamation** is the marine-works workspace: a floor plan, a bathymetric survey, and a section
  sheet are stitched server-side into one 3D site solid, integrated cell by cell for volumes, and
  priced against a shared unit cost matrix, with every geometric assumption recorded beside the
  result.

Each template README explains its domain model, workflows, safeguards, source layout, and verification.
They are designed to be changed as normal Pod workspaces rather than treated as generated product code.

## Working with a template

```bash
pnpm --dir template_workspaces/<template> sync
pnpm --dir template_workspaces/<template> lint
pnpm --dir template_workspaces/<template> build
```

`sync` derives Pod assembly and migrations. Commit authored source and `.norbital/migrations/`, but do
not edit or commit other generated `.norbital` output. Read the [Pod overview](../packages/pod/docs/OVERVIEW.md)
before creating a new role or changing a workspace boundary.

## Release and tenant lifecycle

The public active set, display metadata, compatible Pod range, and projected Git ref namespace are
defined in [`../release/templates.json`](../release/templates.json). Core reads that catalogue and the
root-projected template refs from a configured remote Git repository; templates are not copied into
object storage.

The current catalogue is compatible with Pod `0.0.1`, and each projected template manifest pins
`@norbital-ai/pod` to exactly that version. Publishing advances the fast-forward-only
`refs/heads/templates/<key>` branch to a new commit; a tenant records the exact commit rather than
tracking the moving branch implicitly. That tenant must explicitly merge or rebase the revision and
deploy a new checkpoint with a compatible platform release.

No template archive or package tarball is committed under this directory. Template source is distributed
through ordinary Git refs. Package archives used for publication and platform assembly are generated in
temporary or ignored release directories, validated, and addressed by integrity in the platform manifest.
See the provider-neutral [distribution contract](../release/README.md).

Editing this checkout never changes an existing tenant, and a tenant’s local changes must be merged or
rebased intentionally rather than overwritten by a template update.
