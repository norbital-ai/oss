# Current examples

These are places to inspect, not frozen code snippets. Check the current source before copying
API names or fixture shapes; a reference must not preserve a retired runtime contract.

## Native workspace success and refusal

For a fixture workspace whose `orders` model allows an administrator to create records,
the scoped kit drives the real host routes. A denied create fails with `ActRefused` and leaves
the row count unchanged:

```ts
import { Effect } from "effect";
import { TestWorkspace, expect, layer } from "@norbital-ai/bolt/test";

layer(TestWorkspace.layer({ root, seed: "none" }))("orders", (it) => {
  it.effect("commits an admitted create and preserves rows after denial", () =>
    Effect.gen(function* () {
      const t = yield* TestWorkspace;
      const admin = t.as(t.admin);
      expect(
        (yield* admin.act("orders.create", [{ notes: "Allowed" }])).kind,
      ).toBe("committed");
      const before = yield* admin.query({ orders: {} });
      const failure = yield* Effect.flip(
        t.as(t.member([])).act("orders.create", [{ notes: "Denied" }]),
      );
      expect(failure).toMatchObject({ _tag: "ActRefused", code: "forbidden" });
      expect((yield* admin.query({ orders: {} })).orders.rows).toEqual(
        before.orders.rows,
      );
    }),
  );
});
```

Replace the model and fields with the owning workspace's declared contract. Removing the
grant check must fail the refusal assertion; writing before denial must fail the persisted-row
assertion. `TestWorkspace.layer` owns the database and host scope, including cleanup on failure.

## The test seed pack

A template's tests seed from `seed/test/`, authored like `seed/`: `<model>.json[.gz]` (basename = model, any
subdirectory), identity rows as `sys_user.json`, optional `assets.json` + `assets/**`. No `seed.ts`, no bank.
`bolt check` decodes it; `bolt build` writes it to `.norbital/seed/test` with its own digest; no host provisions it.
The kit builds it once per source hash and loads it into every `TestWorkspace.layer({ root })` (it does not
layer on `base`; a row a test needs is in `seed/test/`).

```text
seed/test/
├── sys_user.json      [{ "id": "u-admin", "name": "Ada Admin", "email": "ada@example.test", "kind": "staff", "admin": true }]
└── orders.json        [{ "id": "o-1", "notes": "Open order", "status": "open" },
                        { "id": "o-2", "notes": "Closed order", "status": "closed" }]
```

```ts
layer(TestWorkspace.layer({ root }))("orders seed", (it) => {
  it.effect("refuses edits to a closed order", () =>
    Effect.gen(function* () {
      const t = yield* TestWorkspace;
      const failure = yield* Effect.flip(
        t.as(t.admin).act("orders.update", [{ id: "o-2", notes: "Changed" }]),
      );
      expect(failure).toMatchObject({ _tag: "ActRefused" });
    }),
  );
});
```

Keep it to the few rows the mechanisms need: two states, one boundary, one refusal. Catalogue data the
product ships belongs in `base`; a test that needs a catalogue row writes its own synthetic one here.

## Inline business configuration and source access control

`templates/hr-payroll/tests/e2e/source-team-values.test.ts` drives the real authored engine. It
checks that suspension kinds live on their version, validates duplicate/empty codes, clones values
into a successor and refuses sealed edits. It also resolves source-team grants and approval eligibility while refusing writes to the
generated team catalogue. Team definitions, policy links and inline approvals are source;
member affiliation is runtime identity data.

The useful distinction is between a pure shape check and the write-path proof: a parser can
recognize valid values while the model forgets to invoke it. Use both only where they cover
different defects. The persisted version and refusal assertions carry the behaviour.

## Record capabilities and disclosure

`oss/packages/bolt/tests/record-capabilities.integration.test.ts` uses PGlite and native reads/grants.
It checks readable fields, masks, layers under the root's policy and scope changes during capability reads.
A UI implementation guessing from an update contract would not satisfy those assertions.

Shared UI tests in the ui package should similarly exercise admitted/readonly fields, draft edits,
cancel, conflict and save outcomes. Alignment, overlap and narrow layout are probes, never tests.

## Authorization before credentials

`oss/packages/bolt/tests/integration-links.integration.test.ts` keeps the links manager, the
instance verbs and the engine real, with an injected provider. "authorize as \"may update this
row\"…" pairs the owner's and an administrator's success with an unsigned caller, another member,
an external member and a cross-site request, and asserts nothing was sealed after each denial. A
refusal-only suite would also accept a handler that refuses everyone. The same file proves fenced
credential writes (a second opener stops the first as `replaced`) and that an emit resolves only
after the engine committed its rows.

The sealed-credential assertion is meaningful because ordering is the requirement. Provider-open
counts alone would not prove that sync rows were written; that needs a state assertion.

## Integrations, syncs and envoys

`sync.integration.test.ts`, `sync-health.integration.test.ts`,
`file-sync-authority.integration.test.ts`, `conversations.integration.test.ts` and
`hotline.integration.test.ts` under `oss/packages/bolt/tests/` exercise current sync, caller-scope,
conversation and instance-isolation paths. Keep cursor/row atomicity, outbox retry and idempotency,
approval-held delivery and version-conflict rollback assertions on the native engine. Templates
do not re-test envoy admission or conversation transport; Bolt owns those mechanisms.

A template test reaches the same paths through the kit, stubbing only the link:

- Named instances are the manifest's `connections`; seed unnamed runtime ones as `sys_integration` rows
  (`id, integration, name, owner?, active?, configuration?`) or create them with
  `sys_integration.create`.
- Conversation inbound: `yield* t.receive('<slot>', message)` ingests the message and waits for
  queued sync reads and envoy turns. Use native conversation tests for delivery-report transport.
- Remote reads: `yield* t.syncs.read('<model>.sync.<sync>', { instance: '<slot>' })` drives the
  real remote sync. Set `t.fakes.links.answer` for `ctx.request`, or `t.fakes.links.page` for a
  pushing driver's `items`. Assert persisted rows, cursor/version handling and a repeated read.
- Queued writes: `yield* t.syncs.deliver()` drains the real outbox. Sends through a link appear in
  `t.fakes.links.sent` (`instance`, `message`); request writes use `t.fakes.links.answer`. Read the
  source row's `$sync['<sync>']` status and the acknowledged remote state, including refusal/retry.
- File syncs start as the importing/exporting member with the declared context; test scope and
  masks as well as findings, callback refusal and atomic row results.

Assert stored rows and the record's state, not only that a fake was called.

## Explicit nested edits and revision conflicts

`oss/packages/bolt/tests/write-nested-refs.integration.test.ts` checks actual native parent/child
operations. A stale child revision must conflict and leave both parent and child unchanged. Link,
unlink, update and delete have different semantics; deleting an omitted or filtered row would
violate the contract even if a simple create case passed.

For UI coverage, preserve unloaded children and submit only staged operations. Test a filtered
page and beyond-page rows rather than assuming a short fixture represents the complete relation.

## Migration replay and build integrity

`oss/packages/bolt/tests/migrations.integration.test.ts` exercises migration replay and database
definitions against owned PGlite. Native PostgreSQL replay runs in deployed staging/production
acceptance. A workspace keeps numbered SQL, `snapshot.json`, `migrations.lock.json` and
`physical.json` under root `migrations/`. Builds compare replay with the declared source; checks
verify each physical prefix, and hosts apply the verified history under the SQL lock. Preserve
applied SQL and add forward migrations rather than editing historical files or proof hashes.

Artifact integrity and migration proof do not establish which revision a running host activated;
inspect the active artifact separately.

## Controlled time

`norbital/apps/colony/tests/billing-gate.test.ts` demonstrates a cache deadline controlled by
TestClock. Its temporal assertions do not depend on machine load. Code whose timing cannot be
driven by an injected clock needs that seam added, not a real wait in the test.

## Pruning

For each assertion, name the edit that makes it fail. Replace existence-only assertions with
behaviour, remove duplicate coverage and retire tests of removed APIs. Keep deliberate gaps
visible: rendered controls, persisted state, vendor compatibility and separate-process ownership
are distinct claims: the first two are tests, the last two are probes.
