# Pipelines

**What this pillar protects:** that an authored export or import pipeline is authorized, scoped to
the caller's policy, and serialized as the workspace declared — not as whatever the client asked for.

## Why these tests exist

An export is a bulk read with a file attached. That makes it the easiest place in the product to
leak: the request names a collection and a record set, and if the runtime honours that naming
without re-applying the caller's policy, an export becomes a way to read past it. The test therefore
drives the public runtime route end to end against a compiled template rather than calling the
pipeline function directly.

| File                   | Owns                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline-e2e.test.ts` | An authenticated, record-scoped export through the public runtime of a compiled Field Operations workspace: authorization, scope, invocation, and output serialization. |

## The rule for adding to this pillar

A template that declares a new pipeline must bring a compiled-runtime test with it. A pipeline that
exists but is never invoked in a test is indistinguishable from one that does not work, and the
absence cannot be turned into a passing test by probing for the feature and accepting either
outcome.

## Not here

Automations, which are triggered rather than requested — see
[`../automations`](../automations/README.md).
