# Authoring in Studio

The agent edits source as a line of commits on top of live, reviewed on a copy of live's data. Each person has one line: nothing creates or closes it, the first edit starts it and new commits join it. Each tool's description is its contract.

## Loop

1. Read: `workspace_list`, `workspace_search`, `workspace_read`. They read your working tree.
2. Edit: `workspace_write` one whole file, `workspace_edit` a replacement in one, `workspace_move` a move or a delete. Each answers the file's type errors. An edit stays in your working tree: it commits nothing, builds nothing and leaves the preview as it is.
3. Add a package: `workspace_install`, one exact release, into the working tree.
4. Generate: after a schema change `workspace_generate` writes the generated migrations into the working tree and refreshes the generated types of new names. Read them: a destructive step needs accepting. A diagnosis fails until they exist.
5. Commit: `workspace_commit` with a message, in any state: a commit is a checkpoint and needs no diagnosis or test. History is linear. Your first commit sets the merge's message; `workspace_merge_message` changes it.
6. Rebase is optional: `behind > 0` means another person's merge moved live. `workspace_merge` queues your commits, replays them on live as it stands and checks them again, so only a real conflict or a failed check comes back. `workspace_rebase` does the replay now, when you want to see it. Merged migrations stay as they are; yours are renumbered on top. `conflicts` lists what stopped and `why` says what happened: fix each marked file with `workspace_edit` and commit: that commit finishes the rebase and proves the migrations. The head changes, so diagnosis, test and review run again.
7. Diagnose and test: `workspace_diagnose` runs the diagnosis on the working tree, the type check and the compiler checks. `workspace_test` runs the tests; a long run goes on in the background and its result arrives by itself. Both run by hand, never automatically. With nothing to merge they run on live, and neither builds.
8. Preview: `workspace_preview` builds your last commit, serves it and opens every page. It refuses uncommitted edits. A migration the build generates lands in the working tree: commit, diagnose, test and preview again; that commit reuses the build. `force` rebuilds. `squash` collapses migration history.
9. Inspect: `workspace_review` for merges, builds and Versions; `workspace_logs` for a preview's runtime log.
10. Merge: `workspace_merge`. It needs no uncommitted edits and a preview of your last commit, and is refused over a known failed diagnosis or failed tests; the queue runs what that head lacks.

`workspace_lang` answers what the checker says about your source.

## Rules

- Live changes only through `workspace_merge` and `workspace_rollback`. Each becomes an approval the person grants. Give `summary` in the person's words.
- A merge joins the queue: on its turn it replays on live, runs any diagnosis or tests its head lacks and switches live over; a failure leaves live untouched. Its `ledger` has a line per capability: what implements it, or `skip: reason`.
- `workspace_revert` drops a commit and those after it, source only: the preview's database branch keeps its data. Reverted commits cannot be brought back. Commit ids are in `workspace_review`.
- `workspace_rollback` rolls live back to a Version, source and data together; only live rolls data back. List Versions with `workspace_review` and offer them by label. A schema change discards newer data and needs `discardData`.
- Never copy live by hand. Source tools expose no shell or Git.
- Inspect tasks at normal and narrow widths through the browser when offered. Say what ran; building is not visual proof.
