---
'@norbital-ai/pod': patch
---

Show each tool call, and give the composer its model picker back.

The agent transcript collapsed a turn's calls into one `Using read_collection, read_collection…`
line and discarded `role === 'tool'` rows outright, so two different reads of two different
collections were indistinguishable and no result was ever visible. Each call now renders as its own
row — icon, label, and the identifying argument — with its input, error and result joined to it by
`toolCallId`. Results are collapsed by default and capped, because a tool result is the reader's own
policy-filtered data but still is not conversation.

A thrown tool was previously fed back to the model as `{ error }` while the run reported success;
those now render as a failed call.

The composer regains the model picker lost when the agent moved out of the host. It reads the host's
catalog through the new optional `HostAiBinding.models()` and sends a model only when the choice
differs from the host default, so an untouched picker never turns a display value into a caller
assertion. A caller-supplied model is rejected unless the host advertises it: model choice is spend,
so the ceiling belongs to the side holding the credentials. A host without `models()` renders no
picker.
