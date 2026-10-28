# Supplying dependencies

Use the subject's actual dependency seam. Native Bolt I/O uses declared service tags and layers;
pure value functions take plain inputs. The workspace kit's `ports` option accepts a native Layer
over the allowed host-port tags. Supply the existing seam rather than adding another runtime.

## Keep the logic real

Replace unavailable I/O, time or identity inputs, not the logic being verified. A provider test can
inject HTTP requests and observe cancellation; a grant test must drive native authorization rather
than a helper that recomputes its answer. A database fake cannot establish foreign-key, transaction
or advisory-lock behaviour.

Use a narrow dependency returning the real contract shape. Record outputs such as sent messages,
state changes or aborts so assertions observe behaviour. Unexpected facilities should fail loudly.
Do not supply an all-purpose fake runtime that silently answers methods the subject did not need.

Current native examples include:

- `oss/packages/bolt/tests/integration-links.integration.test.ts`: the actual links manager,
  instance verbs and engine over a narrow injected provider; checks authorization before any
  credential is sealed or read.
- The test kit's `t.fakes.links` (`@norbital-ai/bolt/test`): the default link of every instance.
  It records sends and answers only the `answer` / `page` a test sets; anything else fails loudly
  (`'<instance>' has no link`).
- `oss/packages/bolt/tests/record-capabilities.integration.test.ts`: real PGlite reads and native
  grant evaluation; masked and unreadable names do not leak into capabilities.

Inspect the current file before copying fixture types or helper names.

## Existing Effect services

When the subject uses `Context.Service`, supply its declared service using a test layer or
`Layer.succeed`. Reuse the module's working test implementation when available. A layer intended
for unavailable facilities must fail if called; a stub returning success conceals unintended I/O.
Do not assume every module has a `layerTest` or an `Interface` export. Follow the current module and applicable architecture rules.

Dispose a `ManagedRuntime` or scoped service after the test, including failure paths. Provide
only what the case uses. The useful invariant is ownership and cleanup, not a fixed count of
service files or layers.

## Module substitution

Occasionally a route closes over a runtime at import time. If changing its public seam is not
appropriate, substitute that one dependency, preserve the remaining module with `importOriginal`
and import the subject after registration. State why the substituted runtime cannot affect the
property being asserted. Do not mock the authorization or parsing rule the test names.

A dynamically imported cold runtime belongs in fixture setup when module acquisition is not the
behaviour under test. Do not let a five-second test mostly measure loading an unrelated graph, or
hide that mistake by raising the timeout. Import timing is a benchmark: a probe, never a test.

## Inputs and environment

Build fields the subject actually consults: method/body, signed session, cookies, fetch and so on.
Pair malformed/denied cases with an admitted case through the same route so a setup exception
cannot masquerade as denial.

Passing `undefined` to a defaulted parameter reapplies the default. Use an explicit absent value
supported by the contract when testing missing configuration or credentials. Supply test configuration
through `ConfigProvider.fromUnknown` and `ConfigProvider.layer`, or pass already decoded configuration.
Ambient `process.env` belongs only in the application's provider setup. A key on a developer's machine must
not make a missing-key test pass.

Credentials remain synthetic and private. Assert error masking at the actual response boundary;
logging a secret and then checking that an internal helper masks it does not prove public safety.
