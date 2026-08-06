---
'@norbital-ai/pod': minor
---

The agent composer can reference records: typing `@` opens a keyboard-driven
menu that searches the workspace's collections and inserts the chosen record as
an atomic chip.

The menu searches flat across every non-system collection at once — the local
replica answers first, with a 150ms debounce and a small per-collection limit —
and a bare `@` offers the collections as scopes for narrowing the search.
Arrow keys navigate, Enter or Tab picks, Esc dismisses without touching the
text, and Backspace on a chip deletes it whole. The draft stays plain text: a
chip is an `@label` span tracked as a range, and an `@` that never matched — or
that the writer edited through — goes to the agent as literal prose.

On send, resolved references ride along as structured mentions. The loop
fetches each one as the requestor — never elevated, so policy still decides
what a mention can see — and appends a snapshot to the turn's model window
only; the stored transcript keeps the clean message the person typed. A
reference that no longer resolves degrades to a `status` attribute and nothing
else: the label stays in the message text, so a bad mention costs prose, never
a failed turn.
