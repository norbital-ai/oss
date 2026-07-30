# Policy condition substitution

Answers checklist item **A1** in `CORE_REFACTOR.md`. Investigation only — no behaviour changed.

## Short answer

`${requestor.norbital_id}` is substituted **at request time**, not at seed time. Core's seeded
conditions — both the `{ field: { eq: '${...}' } }` form and the `$sql` form — are read verbatim
out of `policy.grants[].conditions` and bound against the live `baseScope` on every query. A
declarative policy that writes the same JSON gets the same behaviour, because
`reconcileDeclaredPolicies` stores `where` verbatim.

Nothing bakes a literal uuid in. The seed writes the nine-character literal `${requestor.norbital_id}`
into jsonb — `apps/core/seed/bca/steps/policies.ts` uses single-quoted strings, so JS never
interpolates it.

## Read path (evidence)

1. `resolveCollectionReadPermission` → `evaluatePolicyGrants`
   (`src/lib/server/collection/access_control/permission/collection_permission.guard.server.ts:35-91`)
   never touches `${...}`. It only classifies: empty `conditions` ⇒ `hasDirectAccess`, otherwise the
   raw jsonb is passed out as `reducedCondition` (`:86`).
2. `resolvePolicyWhere` (`src/lib/server/collection/collection_ops.server.ts:116-131`) calls
   `compilePolicyWhere(readScope.reducedCondition, ctx.baseScope)` — this is where the scope arrives.
3. `compilePolicyWhere` (`src/lib/server/collection/access_control/policy_sql.server.ts:99-106`)
   flattens the scope (`flattenScope`, `:16-27` — produces the key `requestor.norbital_id` from
   `baseScope.requestor.norbital_id`) and hands both the nested and flat forms to
   `compilePolicyWhereFromScope` (`:108-130`).
4. **Field conditions** are bound by `bindScopeInValue` (`:60-90`). A string that is *only* a
   placeholder (`'${requestor.norbital_id}'`) is replaced by the resolved **value**, preserving type
   (`:67-70`); a string with surrounding text is interpolated as text (`:71-74`). Arrays and nested
   objects recurse; a nested object carrying `$sql` recurses into the compiler (`:80-82`).
5. **`$sql` conditions** are bound by `compileRawSqlRelationsFilter`
   (`src/lib/authoring/workspace/relations-filter.ts:28-48`). Each `${path}` is replaced with a
   positional `$n` and the scope value is pushed as a **bound parameter** — an unknown path throws
   `Unknown policy scope variable: <path>` (`:37-39`) rather than silently matching nothing. The
   result is a Drizzle `RAW` callback; `parameterizedSql`
   (`policy_sql.server.ts:39-54`) splices the `$n` markers back into real Drizzle params.
6. Field filter and `$sql` are AND-ed (`policy_sql.server.ts:123-127`), then merged with the caller's
   `where` by `mergeWhere` (`src/lib/server/collection/collection_direct.ts:389-397`) inside
   `findMany` / `findFirst` / `countRecords` / `findGrouped`
   (`collection_ops.server.ts:143-152, 200-206, 216-225, 235-243`). The sync stream goes through the
   same functions (`src/lib/server/collection/sync/sync-endpoints.server.ts:31`).

Scope shape confirmed at `packages/platform-utils/src/scope/types.ts:35-39`:
`TBaseScope = { requestor: UserInfo, organization: … }`, so `requestor.norbital_id` and
`organization.norbital_id` are the resolvable roots. `requestor.team_members` resolves to an array
(arrays are leaves in `flattenScope`), usable as an `= ANY($n)` parameter but not as a scalar.

## Write path

`mutationConditionsApply` (`.../access_control/approval_step_conditions.server.ts:141-156`) is the
mutation equivalent and does its own substitution:

- field conditions via `bindScopeValue` (`:39-53`) against `context.scope`, matched in JS against the
  effective record (`:90-108`);
- `$sql` via `matchesSqlCondition` (`:114-138`) — `${...}` again becomes bound `$n` params, and the
  expression is evaluated against a one-row virtual table built from the mutation payload, so
  `"contractor_profile_id" IN (SELECT …)` works on a row that is not yet in the database.

So Core's `job_assignments` update grant and the `variation_requests` / `photo_evidence` create
grants keep their `$sql` semantics.

## Can declarative policies express Core's seeded conditions today?

| Form | Storable via `+<name>.policy.ts`? |
| --- | --- |
| `where: { user_id: { eq: '${requestor.norbital_id}' } }` | **Yes.** Typechecks (`eq?: QueryOperand<T>` is `string` for a uuid column) and is stored verbatim. |
| `where: { $sql: '…${requestor.norbital_id}…' }` | **Runtime yes, compile-time no.** |
| `where: { RAW: (t, ops) => … }` | **No — silently dropped.** |

Detail:

- `reconcileDeclaredPolicies` (`src/lib/server/bootstrap/policy_reconcile.server.ts:52-58`) maps
  `where → conditions` with no transformation, and `manifest/index.ts:246-251` passes `where` through
  by reference. `ManifestPolicyGrantSchema.where` is
  `z.record(z.string(), z.unknown())` (`packages/platform-utils/src/manifest/types.ts:250-257`), which
  accepts a `$sql` key. So the value reaches `conditions` intact and the runtime compiles it.
- **But** the authoring type `SchemaWhere` (`src/lib/authoring/schema/types.ts:104-114`) is a mapped
  type over the row's columns plus exactly `AND | OR | NOT | RAW`. There is no `$sql` member and no
  index signature, so `where: { $sql: … } satisfies Policy` is an excess-property **compile error**.
  Writing Core's `$sql` grants today requires a cast, which defeats the point of declaring them.
- **`RAW` is a trap.** It is in the type, but it is a function: the manifest is written to disk as
  JSON and re-parsed (`src/lib/bin/invocation/standalone.ts:142-151`), and `reconcileDeclaredPolicies`
  additionally does `JSON.stringify(grants)` (`policy_reconcile.server.ts:74`). Either step drops a
  function-valued key. The grant lands in the database as `conditions: {}`, which
  `isUnconditionalPolicyWhere` treats as **unrestricted** (`policy_sql.server.ts:92-96`,
  `collection_permission.guard.server.ts:81-84`). A `RAW` read grant therefore silently grants the
  whole collection instead of a filtered subset. (On the mutation side it fails closed instead —
  `approval_step_conditions.server.ts:92,147` deny on `RAW` — but only if it survived, which it does
  not.) `CORE_REFACTOR.md` A2 currently says to port `bca`'s `$sql` subqueries "through the `RAW`
  escape hatch"; that route does not work.

### What would need to be added

To port `bca` (A2) without casts, one of:

1. Add `$sql?: string` to `SchemaWhere` (`src/lib/authoring/schema/types.ts:104-114`) — or a
   policy-specific `where` type — so the already-working runtime form is expressible. Smallest change;
   the whole runtime path already exists and needs no edit.
2. And, separately, make `RAW` in a policy `where` a hard compile or reconcile error rather than a
   silent drop. Anything that cannot survive `JSON.stringify` must not typecheck in a policy file.

## Other observations (not blocking, noted while tracing)

- `evaluatePolicyGrants` overwrites rather than accumulates: `result.reducedCondition = conditions`
  (`collection_permission.guard.server.ts:86`) in a loop over grants, so when a requestor holds two
  *conditional* read grants on the same collection, only the **last** applies — grants intersect by
  accident instead of OR-ing. Core's `bca_contractor` has one read grant per collection, so it is
  unaffected today.
- No test in this repo exercises `${…}` substitution: `grep -rn '\${requestor'` over `packages/` and
  `template_workspaces/` finds only an unrelated log string. Porting `bca` should come with one.
- `template_workspaces/crm/src/policies/+sales_rep.policy.ts:19-21` comments its `quotes` read grant
  as "scoped to the requestor's own records" but the condition is `{ owner_id: { isNotNull: true } }`,
  which scopes to nothing. It is the only declared policy in the repo and is not a working example of
  requestor scoping.
