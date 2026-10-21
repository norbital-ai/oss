# Changing the workspace in Studio

Workspace Studio is the same path as [asking Norbius](./norbius-changes.md), by hand: edit the source, preview it,
publish or merge it, and roll back if needed. Every step that changes what the workspace's users get asks for an
explicit approval that says what it changes.

## 1. Edit

Open **Studio** from the sidebar. The Workbench shows the source tree and an editor over your own draft; nobody else
sees it. Edit, then **Save**.

![Editing in the Workbench](./images/studio-flow-1.png)

## 2. Preview

Press **Preview**. The draft is built and opens as a preview, already signed in as you — no second sign-in. A banner
reads "Preview — changes here are not live yet." with **Open live workspace** to return.

![The preview with its banner](./images/studio-flow-2.png)

## 3. Publish or merge

**Publish** (an administrator's own draft) or **Merge** (an approved merge request on the Changes tab) first asks:
"Publish your draft to live?" or "Merge !12 into live?", with the commit message or merge request title below it.
Nothing changes until you confirm. While it runs every Studio button is disabled, so a double click cannot start a
second run, and a strip under the title reports "Getting ready…" → "Building…" → "Switching over…", then
"Done — live runs the new version." or "Failed: <reason>".

![The publish confirmation](./images/studio-flow-3.png)

![The progress strip while switching over](./images/studio-flow-4.png)

## 4. Roll back

On the **Live** tab pick a deployment (a checkpoint) and press **Roll back**. The confirmation shows the checkpoint's
time and description, and says either that all data is kept or, when the schema changed since, that data written after
that time will be lost. The same progress strip follows. Everyone stays signed in, including people who signed in
after the checkpoint: a rollback restores business data, never sign-ins.

![The rollback confirmation](./images/studio-flow-5.png)

## What everyone else sees

During the few seconds of a switch-over, other people's pages wait instead of failing; a small "Updating to a new
version…" notice shows at the bottom. Afterwards their pages reload into the new version, or offer **Reload** when they
have unsaved work.

![The updating notice](./images/studio-flow-6.png)

## Screenshots to capture

| File                | Must show                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `studio-flow-1.png` | The Workbench with a file open and an unsaved edit (the Save button enabled).                     |
| `studio-flow-2.png` | The preview tab opened from Preview, signed in, with the preview banner and Open live workspace.  |
| `studio-flow-3.png` | The publish confirmation dialog: its title, the draft's commit message and changed-file count.    |
| `studio-flow-4.png` | The progress strip reading "Switching over…" with a spinner, and the Studio buttons disabled.     |
| `studio-flow-5.png` | The rollback confirmation for a checkpoint whose schema differs: time, description, data warning. |
| `studio-flow-6.png` | Another member's page during the switch-over: content still on screen and the "Updating" notice.  |
