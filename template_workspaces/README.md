# Template workspaces

Shipped starter workspaces live in this directory. Each is a standalone filesystem-first Pod
project that can be synchronized, checked, built, migrated, and seeded with the public Pod CLI.

| Template                                    | Directory           | Purpose                                                                        |
| ------------------------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| [**hr-payroll**](./hr-payroll/)             | `hr-payroll/`       | Multi-country HR and payroll with effective-dated facts and payroll runs       |
| [**construction**](./construction/)         | `construction/`     | Project-centered construction ops with BIM and workforce compliance            |
| [**field-operations**](./field-operations/) | `field-operations/` | Site operations: contractor visits, variation approvals, photo integrity       |
| [**crm**](./crm/)                           | `crm/`              | B2B quoting and pipeline with purchasing, mirrored masters, and an ERP handoff |

## Choosing a template

- **Field Operations** is the focused choice for day-of-work dispatch, qualification checks,
  site evidence, and variation requests.
- **Construction Operations** covers wider project delivery: workforce permits, quality, RFIs,
  BIM references, payment claims, and scheduled operational watches.
- **CRM** runs a B2B deal end to end: accounts with their credit position, catalogue-backed quoting
  with payment and shipping terms, revision-safe pipeline, and a confirmed-document handoff to the
  third-party ERP — together with the purchasing, supplier, and indicative stock position that make
  those commitments deliverable.
- **HR & Payroll** is the specialised multi-country payroll workspace, including attendance, leave,
  statutory contribution configuration, and reconciliation guidance.

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

Each template declares itself with a `norbital.template.json` at the root of its own tree — key,
display metadata, and picker counts. It projects with the template, so a tenant fork carries it and
nothing has to be kept in sync in a second place. Core resolves the set with one
`git ls-remote --heads <url> 'refs/heads/templates/*'`; there is no mirror and no catalogue file.

Each template also commits its own `pnpm-lock.yaml` and pins its own `@norbital-ai/pod` version.
Nothing propagates a bump into a template: a developer runs `pnpm templates:lock` when they choose
to move. Publishing a new pod version changes no template and rebuilds no tenant.

Publishing advances the fast-forward-only `refs/heads/templates/<key>` branch to a new commit. A
tenant is _forked_ from that commit, so it shares ancestry with the template and adopting a newer
one is a real three-way rebase, not a conflicting re-add of every file. A tenant records the exact
commit it adopted rather than tracking the moving branch implicitly, and is told when its upstream
is ahead — it never moves on its own.

No template archive or package tarball is committed under this directory. Template source is
distributed through ordinary Git refs, and dependency bytes live in one shared content-addressed
pnpm store. See the provider-neutral [distribution contract](../release/README.md).

Editing this checkout never changes an existing tenant, and a tenant's local changes must be merged
or rebased intentionally rather than overwritten by a template update.
