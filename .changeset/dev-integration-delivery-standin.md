---
'@norbital-ai/pod': minor
---

Stand in for integration delivery under `pod dev`, so declaring an integration cannot make a
workspace unrunnable locally.

A workspace whose manifest carries an integration requires `integrationDelivery` before it starts,
and that gate is right: the outbox has nowhere to drain without it, so a workspace that booted anyway
would accumulate rows that retry with backoff and dead-letter after ten attempts, far from the cause.
What was missing is the other half of the bargain Pod already makes for messaging. The development
host `pod dev` builds for a `mode: 'core'` target holds none of the credentials an outbound call
needs, so it declared no delivery at all — and a Core-targeted workspace that declares an integration
therefore refused to start, naming a facility no development machine could ever have supplied, on the
one command that is meant to run it. The `crm` template is exactly that workspace: it stopped being
runnable with `pod dev` the moment it gained its external-system integration.

`consoleIntegrationDelivery()` is the counterpart of `consoleMessaging()`. It logs the binding, the
record, the declared destination and the payload instead of putting them on a wire, and reports
success so the local outbox settles instead of filling with retries an author has to explain while
working on something else entirely. `pod dev` supplies it and nothing else does. A deployed host still
names `httpIntegrationDelivery()` or a function of its own, and `pod start` still refuses a
self-hosted configuration that names neither — a real deployment quietly writing its outbound
deliveries to a console is the failure this must not turn into.
