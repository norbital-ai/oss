# Rebuilding an existing application

Preserve source behaviour, not legacy framework or infrastructure.

## Read & inventory

1. Attached archive: `read_file { id }` / `{ id, path }`. Repo URL: `reference { repository, ref }` once, then `read_file` with the reference name. If `needs_connection`, open GitHub integration setup for a read-only Contents token and retry (never collect credentials in chat).
2. Record revision/snapshot, follow routes to forms, rules, calculations and tests, and batch reads in `run_js` returning distinct paths, domain keys and short excerpts (use `workspace_grep { count: true }` for target totals).
3. Maintain a coverage ledger mapping source path → Bolt implementation → test evidence → gaps across: models/relations, outputs/layers, guarded writes/approvals, pages, representations, automations, file/remote syncs, kinds/children, charts, teams, policies, tests and seed. Every skipped category needs a reason (`workspace_merge` refuses bare skips).

## Build & prove

- Finish one user journey end-to-end (entry, completion, denied role) per module before expanding. Declare usable policies and seed the teams (`sys_team` rows) that hold them and their members. Justify each model per [model-boundaries.md](model-boundaries.md).
- Test authored operations and page inputs (not just helpers): currency math, date boundaries, exact/over limits, denied roles (`t.sign_in(address)` → `t.as`), repeated imports, child edits under locked parents, refused child atomicity, overlapping-role self-review denial, per-record named-approver denial of another team member, conditional form discriminators, and missing-FX/error/loading chart states.
- Run `workspace_test` (writing a test ≠ executing it); inspect preview at desktop and narrow widths (report blocked checks honestly; never claim parity from a green build). Verify live Version and routes after merge.
