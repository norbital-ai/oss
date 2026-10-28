# Authoring in Studio

In a hosted workspace, the agent edits source through Studio's tools, one **change** at a time: a named set of
edits from live, with its own preview on a fork of live's data.

- `workspace_review` lists the changes, their builds and the Versions live ran.
- `workspace_search { draft: true }` finds and reads your change; `workspace_write` commits its creates, edits,
  moves and deletes in one save (with no change open, it opens one named by the summary). A save only commits.
- `workspace_validate` is the preview and the only build: it builds the head, serves it on a fork of live's data
  and answers the preview URL or the diagnostics. Preview the latest commit before merging.
- `behind > 0` means live moved on: the merge takes it in; never copy live in by hand. Conflicts land in your
  change as marked files to resolve with `workspace_write`.
- `workspace_build` reads a retained build's log and diagnostics.
- `workspace_lang` answers what TypeScript's checker says about live or (`draft: true`) your change: hover,
  definition, references, outline, completions, signature, a file's errors, and a type over Bolt's names
  (`Row<'c'>`, `ActInput<'c.create'>`). `workspace_diagnose` runs the full check and the organization's audit on
  your change's head.
- `docs` answers what bolt, ui and std export, and reads these skills; search it before guessing an API.

## Live changes only by approval

`workspace_merge` (your change) and `workspace_rollback` (a Version again, source and data together, with an undo
Version kept) are the only ways live changes. Each becomes an approval request the person approves, and it runs
as them. Always give `summary` in the person's words: what the change does and why. To roll back, list Versions
with `workspace_review` and offer them by their label.

## Checks

Save, then `workspace_validate`. Read every error and fix it; a change is done only when the build is clean.
Before a merge, `workspace_diagnose` for the type check and the audit. Every merge repeats the full check: type
errors block; audit findings name their rule and never block. Say which checks ran and which did not.
