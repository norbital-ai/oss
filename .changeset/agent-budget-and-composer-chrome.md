---
'@norbital-ai/pod': patch
'@norbital-ai/ui': patch
---

Record the budget-exceeding iteration's spend before failing the turn, and quiet the agent composer chrome.

The agent loop checked its token budget immediately after each provider turn, before the
iteration's tool-call message (which carries the usage when the turn had no prose) was
persisted. A turn that died on the budget therefore showed a session total that omitted the
very spend that exceeded it — a conversation reading "2,018 tokens" next to "budget exceeded
(12000)". The check now runs after the iteration's usage is persisted, and the error names
the consumed total (`12,431 of 12,000 tokens`) so the number can be checked against the
footer.

The composer textarea no longer draws its focus ring: the editor kept the Textarea's
`focus-visible` ring, which read as an active border inside the composer card. The editor
class now overrides the same `focus-visible` variants so tailwind-merge drops them.

Combobox gains `chevronOnHover` for triggers that read as plain text: the chevron is hidden
at rest and revealed on hover and focus-within. The workspace agent's conversation picker
opts in.
