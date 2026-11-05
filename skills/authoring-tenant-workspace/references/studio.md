# Authoring in Studio

The agent edits source one change at a time: a named set of edits from live, previewed on a copy of live's data. Each tool's description is its contract.

## Loop

1. Read: `workspace_list`, `workspace_search`, `workspace_read`. They work on your current tree.
2. Save: `workspace_write`, one commit with many changes. `{ path, text }` replaces the whole file; `{ path, find, replace, all? }` edits; `{ path, to }` moves; `{ path, delete }` removes. It answers the changed files' type errors. A save does not build.
3. Add a package: `workspace_install`, one exact release.
4. Check: `workspace_validate` builds the head, opens every page and runs the type check and tests. `only` runs one of preview, types or tests; types and tests also check live with no change open. `force` rebuilds. `squash` collapses migration history.
5. Inspect: `workspace_review` for changes, builds and Versions; `workspace_logs` for a preview's runtime log.
6. Ship: `workspace_merge`. It needs a preview of the head.

`workspace_lang` answers what the checker says about your source.

## Rules

- Live changes only through `workspace_merge` and `workspace_rollback`. Each becomes an approval the person grants. Give `summary` in the person's words.
- A merge rebuilds, type-checks and tests before switching; a failure leaves live untouched. Its `ledger` has a line per capability: what implements it, or `skip: reason`.
- `behind > 0` means live moved: the merge takes it in; never copy live by hand. Conflicts land as marked files to resolve with `workspace_write`.
- To roll back, list Versions with `workspace_review` and offer them by label. A schema change discards newer data and needs `discardData`.
- Source tools expose no shell or Git.
- Inspect tasks at normal and narrow widths through the browser when offered. Say which checks ran; building is not visual proof.
