---
'@norbital-ai/platform-utils': patch
---

Let a host offer a choice of model.

`HostAiBinding` gains an optional `models(): Promise<AiModelCatalog>`, returning the host's default
alongside the ids it will actually run. Optional rather than required, because a host may hold one
set of credentials and offer no choice at all — and an empty catalog would misreport that as "no
models available" rather than "no choice offered".

The catalog stays on the host side deliberately. The host holds the credentials and decides the
default, so a guest-side list would be a second source of truth free to disagree with whatever is
doing the inference. A host that does not implement `models()` renders no picker at all.
