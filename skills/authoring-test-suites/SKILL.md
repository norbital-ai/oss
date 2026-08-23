---
name: authoring-test-suites
description: >-
  How to author, review, and delete tests in this codebase. Load before writing a test, before
  adding a suite to a new module, when deciding between a unit test and an integration test, when a
  test needs a dependency it cannot have (a database, a browser, a clock, an AI provider), when
  reviewing a suite for tests that cannot fail, and when pruning. Covers Effect layer injection and
  `layerTest`, `it.effect` vs `it.live` and the TestClock trap, what makes a test false confidence
  rather than coverage, and the criteria for deleting one.
license: MIT
metadata:
  package: '@norbital-ai/bolt'
---

# Authoring test suites

A test exists to fail. That is its entire job: to go red, one day, for one specific reason, and to
name that reason clearly enough that somebody can act on it. Everything below follows from taking
that seriously.

The corollary is the thing this skill is really about. **A green test that cannot fail for the
reason it was written is worse than no test at all.** No test leaves an unknown as an unknown. A
test that cannot fail converts the unknown into a wrong belief, and then defends it — because
whoever comes next reads the test name, sees green, and stops looking. Every serious defect this
repository has shipped was under a green suite at the time.

## The default

**Write a unit test that supplies the subject's dependencies as test layers.** That is the shape
almost every test in this repository should take, and the Effect refactor exists in large part to
make it possible: services declare their dependencies as `Context.Service` tags, so a test provides
a different implementation of the same contract and drives the real code with it.

Reach past it only when the behaviour is genuinely unobservable at that level:

| The behaviour under test                                                  | What to write                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| A rule, a calculation, a decision, a state machine, a projection          | Unit test, dependencies as layers or as a narrow double                |
| A service's public method, including its failures                         | Unit test through the tag's `Interface`, over `layerTest` dependencies |
| Something Postgres does — a constraint, a cascade, an index, a query plan | Integration test against a real database (PGlite or a live Postgres)   |
| A migration actually applying to a schema                                 | Integration test through the real lineage                              |
| A wire protocol — HTTP status, WebSocket frames, SSE cancellation         | Integration test against a real server                                 |
| A production build producing something different from the dev build       | End-to-end test that shells out to the real build                      |

Integration and end-to-end tests are rare and deliberate. Each one is a claim that the behaviour
cannot be seen any other way; if you cannot say what specifically is invisible at the unit level,
you are writing a slow unit test.

## "Higher level" means the unit of behaviour, not the unit of code

Raise the level by widening what the assertion is _about_, never by widening what the test _boots_.

- Test a service through its public interface. Do not reach for a private helper — if a helper is
  worth pinning it is worth exporting, and if it is not worth exporting the behaviour it serves is
  what you should be asserting.
- Do not boot a composition to test a behaviour. `operations-authority.test.ts` substitutes exactly
  one thing (the runtime) and states why the rest stays real: the handler's live graph would need
  Postgres, an isolate loader, and a gateway, "none of which say anything about who may call the
  endpoint" (`norbital/apps/colony/tests/hosting/operations-authority.test.ts:34`).
- One test file should be about one thing that can be wrong. `settlement-lock.test.ts` covers a
  single rule at four levels because the rule is enforced in four places, and its header names all
  four and names what it deliberately does not cover
  (`templates/hr-payroll/src/collections/payroll_runs/settlement-lock.test.ts:1`).

## How to supply a dependency

Services are declared as a contract module holding `type Interface`, a
`Context.Service<Interface>('@colony/…')` tag, and **three** layers. `<name>.live.ts` holds only the
real provider, and only `app.ts` may import it.

| Layer              | What it is                                              | When a test uses it                    |
| ------------------ | ------------------------------------------------------- | -------------------------------------- |
| `layer` / `layer*` | The real provider, in `.live.ts`                        | Never, in a unit test                  |
| `layerTest`        | A working in-memory implementation of the same contract | Every dependency the behaviour needs   |
| `layerUnavailable` | A binding that fails loudly when anything calls it      | Every dependency it must **not** reach |

```ts
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

it.effect('is idempotent across a repeated call', () =>
	Effect.gen(function* () {
		/* drive the subject through its public interface, assert the resulting state */
	}).pipe(Effect.provide(TransportFacility.layerTest(handler)))
);
```

`layerTest` is a real implementation, not a spy — that is what makes behavioural assertions possible
at all. And bind `layerUnavailable` rather than a fake for anything out of scope: a fake answers and
hides the new call, an unavailable binding fails and reports it. If you find yourself reaching for
`vi.mock` to replace a _service_, the service is not injected properly and that is the bug.

Details, the module-substitution escape hatch, and the narrow-double pattern for authored template
code: [dependency-injection.md](references/dependency-injection.md).

## Assert the effect, never the call

`expect(mock).toHaveBeenCalled()` proves the test wired the mock up. It does not prove the system
did anything. Assert the state that changed, the row that exists, the value returned, the refusal
that came back — and where a refusal is the point, assert _both_ that it was refused and that
nothing happened anyway. A 403 that still writes the record passes a status-only assertion; the
authority suite reads the control store back for exactly that reason
(`norbital/apps/colony/tests/hosting/operations-authority.test.ts:193`).

There are two exceptions and they are narrow. A callback passed _into_ the subject is an output
port, so asserting it fired is asserting behaviour — but pair it with a state assertion, the way
`oss/packages/bolt/tests/client/replica.test.ts:189` follows `expect(onError).toHaveBeenCalled()`
with the cursor that must not have advanced. And an ordering or dispatch sequence can be the
behaviour, in which case record it and assert the recorded sequence, not the fact of a call
(`templates/hr-payroll/src/collections/payroll_runs/settlement-lock.test.ts:255`).

## Never write these

Delete them on sight when you find them; do not add them.

1. **Presence assertions.** A field exists. A component renders. A route is registered. An object is
   `toBeDefined()`. These pass on any implementation that has not been deleted, including one that
   is completely wrong. Assert what the field _contains_, what the component _decides_, what the
   route _refuses_.
2. **Tests pinned to one page's markup.** They fail on every redesign and pass through every real
   regression. Component tests exercise complex components _generically_ — the navigation stack, the
   field resolver, the state machine — not "the People page shows a table". The model is
   `oss/packages/bolt/tests/ui/collection-navigation.test.ts`: four `describe` blocks, every case
   about a decision the navigation machinery makes, not one rendered page.
3. **Tests restating a type.** If the compiler already rejects it, the test is a slower compiler
   with a worse error message. A test that only checks a shape is checking a shape.
4. **Tests that only prove the mock was called.** See above.
5. **Duplicate coverage.** One behaviour, one test. A second test of the same behaviour does not
   double the confidence; it doubles the cost of every future change to that behaviour, and it means
   a change now has to be argued with twice.
6. **Tests keeping dead code alive.** If a helper's only caller is a test, the helper is dead and the
   test is what is hiding that. Colony's plugin suite builds its invocation inline rather than
   through the helper it retired for precisely this reason
   (`norbital/apps/colony/tests/plugins/plugins.test.ts:67`).

## Before you commit a test, answer these

- **What edit makes this go red?** Name it concretely. If the answer is "deleting the function", the
  test asserts existence and should be deleted.
- **Have you seen it fail?** Break the code, watch it go red for the _stated_ reason, restore it. An
  unmutated green is not evidence — a fixture-shape probe was once reported as having caught a bug
  independently when it had only ever run on already-fixed code, and mutation testing showed it never
  fired at all.
- **Does the fixture describe the real system, or the code's assumption about it?** A fixture written
  from what the code expects makes a green suite prove a false premise. Check the shape against the
  real thing.
- **If it asserts a negative, what positive artifact backs it?** "Nothing matched" is indistinguishable
  from "nothing was scanned". Assert a floor on what was examined first — Colony's architecture scan
  survives a moved source root only because `scanned(files, atLeast)` fails when the walk finds too
  little.
- **Does it sleep, retry, or time out?** Then it needs `it.live`, not `it.effect`. See
  [runners-and-harnesses.md](references/runners-and-harnesses.md).
- **Would a reader know why this test exists?** Write the reason above it, in prose, in terms of the
  defect it prevents. This codebase's best tests do this and it is not decoration: the comment is
  what lets the next person tell a deliberate trade-off from a bug.

## What earns a comment

Not the mechanics — the _judgement_. Specifically: why this level and not another; what is
deliberately not covered and who covers it instead; which single assertion fails if the fix is
reverted; and any known weakness you are accepting. `policy_grants.test.ts` restates three runtime
rules as one-line helpers, quotes each from its source, and states in its own header that drift is
the price and why it is worth paying
(`templates/hr-payroll/src/lib/policy_grants.test.ts:16`). A documented weakness is a maintained
test. An undocumented one is a trap.

## Deleting

Deleting a test is normal work, not vandalism — but the bar is that you can say what stops being
checked. Delete when: it cannot fail; it duplicates another test's behaviour; it pins markup or a
type; it exists only to keep code alive; or the behaviour it covered is gone. Do not delete a test
because it is failing, slow, or inconvenient — those are findings, not licences.

When a suite is being pruned wholesale, prune toward this shape: fewer files, each about one thing
that can be wrong, each with a stated reason, each demonstrably capable of going red.

## Reference routing

| Task                                                                            | Reference                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Supplying dependencies: `Context.Service`, `layerTest`, doubles, harnesses      | [dependency-injection.md](references/dependency-injection.md)   |
| `it.effect` vs `it.live`, TestClock, vitest configs, `node --test` in templates | [runners-and-harnesses.md](references/runners-and-harnesses.md) |
| The catalogue of false confidence, each with a real defect it let through       | [false-confidence.md](references/false-confidence.md)           |
| Annotated tests from this repository, and three before/after rewrites           | [worked-examples.md](references/worked-examples.md)             |

Read only the relevant reference. Line numbers in the references are paired with a quoted anchor
phrase, because this tree moves; search the phrase if a line has drifted.

## Running

```bash
pnpm test            # vitest run, in oss packages and in colony
pnpm --filter <pkg> test
```

Templates do not use vitest. They run `node --test` with `--experimental-strip-types` over a fixed
list of globs in the workspace's `package.json`; **a new test file in a directory that list does not
name will never run.** Check the `test` script before assuming your file is in the suite.

Trust exit codes, not console output or task notifications — both have reported success on a failed
gate here.

Two standing rules from `norbital/.agents/context/AGENTS.md:129` that this skill agrees with and
extends: **"E2E tests are probes: green ≠ working, red always broken"**, and **"never fix flakes by
raising timeouts."** A flake is a finding — real time, resource contention, or a race. Raising the
timeout hides all three.
