# Authoring in Studio

In a hosted workspace, the agent edits source through Studio's tools, one **change** at a time: a named set of
edits from live, with its own preview on a fork of live's data.

- `workspace_review` lists the changes, their builds and the Versions live ran.
- Source tools work on your current Studio tree automatically. `workspace_list { path: "src/" }` lists files,
  `workspace_search { pattern: "syncs", literal: true }` greps content, and
  `workspace_read { path: "src/+workspace.ts" }` reads numbered lines. Search requires `pattern`; read requires
  `path`. There is no draft flag to remember. Normal source tools never require selecting a release.
- `workspace_edit { path, oldString, newString }` performs a focused replacement; the match must be unique unless
  `replaceAll: true`. Read the file first; omit displayed line-number prefixes from replacement text.
  `workspace_write` saves whole files or a batch of creates, edits, moves and deletes. `{ path, text }` replaces the
  entire file; it never appends. Use `workspace_edit` for a partial change and preserve the rest of the file.
  Saves commit but do not build.
- `workspace_validate` is the preview and the only build: it builds the head, serves it on a fork of live's data
  and answers the preview URL or the diagnostics. Preview the latest commit before merging.
- `behind > 0` means live moved on: the merge takes it in; never copy live in by hand. Conflicts land in your
  change as marked files to resolve with `workspace_write`.
- `workspace_build` reads a retained build's log and diagnostics.
- `workspace_lang` answers what TypeScript's checker says about your working source: hover,
  definition, references, outline, completions, signature, a file's errors, and a type over Bolt's names
  (`Row<'c'>`, `ActInput<'c.create'>`). `workspace_diagnose` runs the full check on
  your change's head.
- `docs` answers what bolt, ui and std export, and reads these skills; search it before guessing an API.


## Live changes only by approval

`workspace_merge` (your change) and `workspace_rollback` (a Version again, source and data together, with an undo
Version kept) are the only ways live changes. Each becomes an approval request the person approves, and it runs
as them. Always give `summary` in the person's words: what the change does and why. To roll back, list Versions
with `workspace_review` and offer them by their label.

## Checks

Save, then `workspace_validate` to build the preview. It does not run the full TypeScript check or the tests.
After introducing a new API or component pattern, use `workspace_lang` diagnostics on that file before repeating
it across the workspace. `workspace_diagnose {}` is the full compiler/type check; fix its errors before
requesting publication. Use the offered tool names rather than inventing a `workspace_check` alias.
Author behaviour tests and run workspace_test when offered. It runs a fixed, bounded sandbox test job with parsed
counts and failure details in Preview → Tests; it accepts no commands or flags. If test execution needs an operator, say so;
a build does not execute the suite. Source tools never expose shell or Git commands.
Before a merge, `workspace_diagnose` for the type check. Every merge repeats the full check: type
errors block. Inspect the preview's tasks at normal and narrow
widths with `workspace_view` when available. Say which checks ran and which did not; building is not visual proof.
