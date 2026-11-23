# Authoring in Studio

Each person edits source on a linear line of commits on top of live, reviewed on a copy of live's data. Each tool's description is its contract.

## Loop

1. **Read:** `workspace_read` (reads files and lists directories), `workspace_glob`, `workspace_grep`, `workspace_lang`.
2. **Edit:** `workspace_write` (whole file), `workspace_edit` (targeted replacement; pass `edits: [{ oldString, newString }]` to apply multiple hunks in one file in one call), `workspace_delete`, `workspace_move`. Edits stay in your working tree without building, checking or touching preview. Finish the source, then diagnose before migrating.
3. **Dependencies:** `workspace_install` adds one exact release to the working tree.
4. **Migrate:** after a schema change, `workspace_migrate` generates the pending migration into the working tree (rewriting in place until committed), refreshes generated types, and runs migrations on the preview database with optional before/after SQL checks. Review destructive steps requiring `-- accept:`. Resolve type-refresh errors before querying new names with `workspace_lang`.
5. **Commit:** `workspace_commit` checkpoints the working tree in any state (no diagnosis or test required).
6. **Diagnose & test:** `workspace_diagnose` runs compiler, type and Svelte checks on the working tree; `workspace_test` runs the workspace suite (long runs report back asynchronously — Vitest does not run `tsc`). After EVERY final edit (including `tests/*.test.ts`), run BOTH full `workspace_diagnose {}` and `workspace_test {}` before committing and merging.
7. **Preview:** `workspace_preview` builds the last commit (refuses uncommitted edits), serves it and opens every page. `force` rebuilds; `squash` collapses migration history. Use `workspace_try` to exercise writes/automations on preview and `workspace_logs` for runtime logs.
8. **Inspect:** `workspace_history` shows commits, diffs, merges, builds and Versions.
9. **Merge:** `workspace_merge` requires clean working tree, preview of the last commit, and passing full `workspace_diagnose {}` + `workspace_test {}` on that exact commit (never skip either after a final edit). The queue replays commits onto live as it stands (renumbering migrations on top), runs any missing checks, and switches live over atomically. If replay hits conflicts, fix marked files with `workspace_edit` and `workspace_commit`, then re-diagnose, test and preview.

## Rules

- Live changes only via `workspace_merge` and `workspace_rollback` (both require person approval; write `summary` in user terms). Merge `ledger` lists every capability and what implements it (or `skip: reason`).
- `workspace_revert` drops a commit and everything after it (irreversible; commit IDs are in `workspace_history`). Reverting the whole line removes preview and data, leaving live untouched.
- `workspace_rollback` restores live source and data together to a Version from `workspace_history`. Schema rollbacks discard newer data and require the exact `discard_data_since` instant from the preview.
- No shell or Git; never copy live by hand. Visually check normal and narrow widths in browser when available.
