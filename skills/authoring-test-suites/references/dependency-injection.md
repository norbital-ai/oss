# Supplying dependencies

Use the subject's actual seam. Native I/O uses declared service tags and layers; pure functions take plain inputs. The kit's `ports` option takes a native Layer over allowed host-port tags.

## Keep the logic real

- Replace unavailable I/O, time or identity, never the logic verified. A grant test drives native authorization, not a helper recomputing it. A database fake cannot establish foreign keys, transactions or locks.
- Use a narrow dependency returning the real contract shape; record outputs so assertions observe behaviour.
- Unexpected facilities fail loudly. Never supply an all-purpose fake answering methods the subject did not need.
- The kit's link fake records sends and answers only what a test sets; anything else fails.

## Effect services

- Supply a `Context.Service` with a test layer or `Layer.succeed`; reuse a working test implementation when the module has one.
- A layer for unavailable facilities fails if called; a stub returning success conceals I/O.
- Dispose a `ManagedRuntime` or scoped service on failure paths too. Provide only what the case uses.

## Module substitution

- Only when a route closes over a runtime at import and its seam should not change: replace that one dependency, keep the rest with `importOriginal`, import the subject after registration, and state why it cannot affect the asserted property.
- Never mock the authorization or parsing rule the test names.
- A cold dynamic import belongs in fixture setup. Import timing is a probe.

## Inputs and environment

- Build the fields the subject consults. Pair malformed and denied cases with an admitted case through the same route, so a setup exception cannot pose as denial.
- `undefined` to a defaulted parameter reapplies the default: use an explicit absent value for missing configuration.
- Supply configuration through `ConfigProvider.fromUnknown` and `ConfigProvider.layer`, or decoded values. `process.env` belongs only in the application's provider setup.
- Credentials stay synthetic. Assert masking at the actual response boundary.
