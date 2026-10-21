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

## 5. Live progress

After Approve, the card stays and reports each step as it happens: "Getting ready…", "Building the new version…",
"Switching the workspace over. It restarts with the new version: refresh in a few seconds." You can keep using the app meanwhile.

![The approval card reporting progress](./images/norbius-flow-5.png)

## 6. Applied

When the switch-over finishes, the chat reads **Applied — the workspace is now on the new version. Refresh to see it.**
The workspace restarts with the new version; refresh the page to use it.

![The applied outcome in the chat](./images/norbius-flow-6.png)

## Screenshots to capture

| File                 | Must show                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `norbius-flow-1.png` | The Norbius panel on the live workspace with a plain-language change request typed or just sent.     |
| `norbius-flow-2.png` | A running step group: the shimmering "Building the preview…" line and a spinning step, not expanded. |
| `norbius-flow-3.png` | The finished turn: "The preview is ready." with the Open preview button outside the folded steps.    |
| `norbius-flow-4.png` | The preview tab opened from that button, signed in, with the preview banner and Open live workspace. |
| `norbius-flow-5.png` | The approval card after Approve: buttons gone, a progress line such as "Building the new version…".  |
| `norbius-flow-6.png` | The chat after the switch-over: the "Applied — … Refresh to see it." line visible without expanding. |
