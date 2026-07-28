# Template workspaces

Shipped starter workspaces live in this directory. Each is a filesystem-first Pod project you can
lint, build, and seed from Core dev tooling.

| Template         | Directory       | Purpose                                                                  |
| ---------------- | --------------- | ------------------------------------------------------------------------ |
| **hr-payroll**   | `hr-payroll/`   | Multi-country HR and payroll with effective-dated facts and payroll runs |
| **construction** | `construction/` | Project-centered construction ops with BIM and workforce compliance      |
| **bca**          | `bca/`          | Site operations: contractor visits, variation approvals, photo integrity |
| **crm**          | `crm/`          | Customer relationship management with pipelines and activity tracking    |

See each template's README for layout, collections, and verification commands. The public active
set, display metadata, compatibility range, and projected Git ref namespace are defined in
[`../release/templates.json`](../release/templates.json). Core reads that catalogue and the
root-projected template refs from the configured remote Git repository; templates are not copied
into object storage.
