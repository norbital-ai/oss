# Changing the workspace with Norbius

Norbius can change how your workspace works: add a field, a page, a rule or an automation. You never see code. Every
change is tried in a private copy first, and nothing reaches the live workspace until you approve it.

## 1. Ask

Open Norbius and describe the change in your own words, for example "Add a start date to every employee".

![Asking Norbius for a change](./images/norbius-flow-1.png)

## 2. Draft

Norbius drafts the change. While it works, the chat says what it is doing ("Editing the source…", "Building the
preview…") with a spinner, so you can see it is busy without opening anything.

![Norbius drafting the change](./images/norbius-flow-2.png)

## 3. Preview

When the draft is built, the chat shows **The preview is ready.** with an **Open preview** button. The preview opens
in a new tab, already signed in as you: there is no second sign-in. A banner across the top reads "Preview — changes
here are not live yet. Ask Norbius to apply them when you're happy." and its **Open live workspace** button returns you
to the real workspace. Try the change there; anything you enter in a preview stays in the preview.

![The chat's Open preview button](./images/norbius-flow-3.png)

![The preview with its banner](./images/norbius-flow-4.png)

## 4. Approve

Back in the chat, ask Norbius to apply the change. It shows a card naming what will happen, with **Approve** and
**Decline**. Nothing changes until you press Approve. Only an administrator can approve.

**The approval rule.** Every change to what the workspace's users get — publishing, merging, rolling back — waits for an
explicit Approve, and the approval says what it is for. Under the card's plain title, Norbius's summary of the change
("Fix: submission status buttons") is shown in full, followed by the facts Studio holds: the draft's commit message for
a publish; for a rollback, the checkpoint's time and description and whether data written after it will be discarded.
Norbius cannot ask without a summary. The card answers once: a second press, or another tab, never starts a second run.

![The approval card with its summary](./images/norbius-flow-7.png)

## 5. Live progress

After Approve, the card stays and reports each step as it happens: "Getting ready…", "Building the new version…",
"Switching the workspace over. It restarts with the new version: refresh in a few seconds." You can keep using the app meanwhile.

![The approval card reporting progress](./images/norbius-flow-5.png)

## 6. Applied

When the switch-over finishes, the chat reads **Applied — the workspace is now on the new version. Refresh to see it.**
The workspace restarts with the new version; refresh the page to use it.

![The applied outcome in the chat](./images/norbius-flow-6.png)

## Rolling back

Ask Norbius "roll back to before yesterday's change". It lists the checkpoints in plain terms — when, what the change
was, and whether rolling back keeps all data — and asks which one. Its card names the checkpoint ("Roll back to 21 Oct
10:51 — before the status change"); when the schema changed since, a red line warns that data written after that time
will be discarded. After Approve the card reports "Getting ready…", then "Switching the workspace over…", then
**Applied**. Everyone stays signed in, including people who signed in after the checkpoint.

![A rollback approval card](./images/norbius-flow-8.png)

## What everyone else sees

While the workspace switches over (a few seconds), pages keep working: requests wait and a small "Updating to a new
version…" notice shows at the bottom. When the new version is live, open pages reload on their own, or show "This
workspace was updated. Reload to continue with the new version." when a form is unsaved. Nobody is signed out.

The same path without Norbius is [Workspace Studio](./studio-changes.md).

## Screenshots to capture

| File                 | Must show                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `norbius-flow-1.png` | The Norbius panel on the live workspace with a plain-language change request typed or just sent.     |
| `norbius-flow-2.png` | A running step group: the shimmering "Building the preview…" line and a spinning step, not expanded. |
| `norbius-flow-3.png` | The finished turn: "The preview is ready." with the Open preview button outside the folded steps.    |
| `norbius-flow-4.png` | The preview tab opened from that button, signed in, with the preview banner and Open live workspace. |
| `norbius-flow-5.png` | The approval card after Approve: buttons gone, a progress line such as "Building the new version…".  |
| `norbius-flow-6.png` | The chat after the switch-over: the "Applied — … Refresh to see it." line visible without expanding. |
| `norbius-flow-7.png` | A publish card before Approve: plain title, the summary below it, then "Draft: <commit message>".    |
| `norbius-flow-8.png` | A rollback card: the summary, "Checkpoint: <time> — <description>" and the red discard warning.      |
