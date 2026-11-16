---
name: records
agent: true
authoring: false
description: Protocol for reading and writing a workspace's records.
---

1. Know: the catalogue note lists each model you read with its fields and writes; describe_workspace { names } gives a model's outputs, links and write columns.
2. Read: one request with every root, narrowed by where. Pick rows by their relations with is/some/none/every/count. total is the match count; aggregate answers sums, averages and groups instead of rows.
3. Resolve: each referenced record by one exact read. Missing and stated in the source: create it nested if the write allows, else ask. A word search is ranking, not proof of identity or a category count.
4. Write: one act { acts: { "<model>.<verb>": input } }, the whole change atomically, related rows inside their root. A retry reuses its key; a separate intended operation needs a new key. Automations use run, approvals decide, invitations invite and syncs sync. A computed or large batch is a JSON file run_js returned, given as input_file.
5. Report from the answer: a committed write returns its stored rows, past five the columns it wrote; a held write awaits its approvers; a refused one names why.

## Personal and workspace settings

Use `settings` with no input to read your display name and the workspace display name. `name` changes only the speaking member’s own name; `workspace_name` needs their current administrator authority. Neither changes email, workspace handle, teams or permissions. Impersonation uses the member’s authority and keeps the original administrator in the audit. Navigate the current page again to show the new name. For browser-local appearance and language, use `page` on the account menu’s native controls; do not edit workspace source for a personal theme choice. Workspace theme tokens belong to the authoring skill and the normal preview/merge flow.
