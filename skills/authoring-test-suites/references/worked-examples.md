# Worked examples from this repository

Citations are `file:line` plus a quoted anchor; search the phrase if the line has drifted.

---

## 1. What a good test file's header does

```
templates/hr-payroll/src/collections/payroll_runs/settlement-lock.test.ts:1
	"The settlement lock: taken when a run persists, released when the run is deleted, and permanent
	 once the run is paid.

	 Four things are exercised here and they are deliberately four different kinds of check, because
	 the lock is enforced in four different places:
	   1. `claimsForBundle` — what a run claims. Pure arithmetic over one gathered bundle.
	   2. `sourceLock` — how a claim reads as a refusal. Pure, shared verbatim with the screens.
	   3. `payroll_runs` `delete.before` — the refusal that makes a PAID run's claims permanent. The
	      real authored handler, called directly.
	   4. `clearRunResults` — the rebuild's release. The real function, against a database double
	      whose whole surface is the three calls that function makes.

	 What is *not* exercised is the cascade itself, because Postgres performs it. What is checked is
	 that the cascade is declared, which is the only thing this workspace controls."
```

Everything worth copying is in that header:

- **One subject, named as a behaviour** — "the settlement lock", not "persist.ts".
- **The level of each check is chosen and justified.** Pure arithmetic is tested as arithmetic. The
  hook is the *real authored handler, called directly* — not through a booted runtime. The database
  interaction gets a narrow double.
- **The boundary is stated.** Postgres performs the cascade, so this suite does not test the cascade;
  it tests the declaration, which is the part the workspace owns. Naming what you are not covering
  is what stops the next person adding a slow, redundant test to cover it again — and stops a reader
  believing coverage that is not there.

And when the declaration test arrives (`:285`, "the declaration, not the cascade"), it explains what
would have been worse: a hook looping over `api.db.<collection>.delete(identifiers)` "would have been
wrong in a way no happy-path test catches, because that call takes `identifiers[0]` and drops the
rest: the release would free one claim out of several hundred and report success."

That sentence is the whole skill in miniature. The dangerous bugs are the ones that report success.

---

## 2. Before / after: the fixture writes authority somewhere the code does not read

**The defect.** `Identity.workspaceAccess` reports each workspace member's authority. It read the
role array, and `admin` is not a role any workspace declares:

```
oss/packages/bolt/src/runtime/identity/identity.ts:585
	// "The status column, not the role array. `admin` was never a role a workspace declares and is
	//  now explicitly not one, so the old test could only ever have matched a row somebody had
	//  hand-written the string into; every real administrator was listed here as `basic`."
	role: IdentityRows.text(row, 'status') === ADMIN_STATUS ? 'admin' : …
```

**Before** — live in the tree as of this writing
(`oss/packages/bolt/tests/identity/workspace-access.test.ts:39`):

```ts
await addSession(harness, 'u1', ['admin', 'basic'], ['Platform'], 'ada@example.test');
// …
expect(result.members.map(({ id, role }) => [id, role]).sort()).toEqual(
	[[fixtureUserId('u1'), 'admin'], [fixtureUserId('u2'), 'basic']].sort()
);
```

The fixture hand-writes the string `admin` into the *roles* column. Nothing in production ever puts
it there — `admit` writes `bolt_auth_user.status`, and `subjectFromRow` compares against that column
and nothing else (`identity.ts:76`). So this seeds a row no workspace can produce, and pins a mapping
the source no longer performs. It is a test of the fixture.

The same fault, in the same shape, is in the vertical-slice suite: its subject literal carries
`roles: ['admin', 'impersonator']` and no `status`
(`oss/packages/bolt/tests/runtime/vertical-slice.test.ts:155`), so every case named for
administrator behaviour authenticates as an ordinary user.

**After** — seed the column the code actually reads:

```ts
// `status` becomes a parameter, defaulted to 'normal', because administration is a status now and
// the fixture has to say so the way a real workspace does.
await addSession(harness, 'u1', ['basic'], ['Platform'], 'ada@example.test', 'admin');
await addSession(harness, 'u2', ['basic'], ['Platform', 'People'], 'grace@example.test');

const result = await access(harness);
expect(result.members.map(({ id, role }) => [id, role]).sort()).toEqual(
	[[fixtureUserId('u1'), 'admin'], [fixtureUserId('u2'), 'basic']].sort()
);
```

What changed, and why each part matters:

- **Authority is seeded where production writes it.** `u1` now holds an ordinary role ladder *and*
  the status, so the test distinguishes "reads the status column" from "finds the string `admin`
  somewhere in the row" — the two are indistinguishable in the before.
- **Both outcomes are present.** `u1` administers, `u2` does not. A test with only the positive case
  passes against a projection that returns `'admin'` unconditionally.
- **The row is written the way production writes it**, an `insert` into `bolt_auth_user`, so the
  projection's own `select` list decides what comes back. That is what catches the second half of
  this defect: the query also omitted `status`, and a column a query never asks for reads as absent,
  which is exactly `normal`. A double cannot see that — it supplies the row instead of the query
  producing it, so it would return the column the real `select` forgot.
- **The comparison is order-insensitive** — ids are uuids, so asserting order would be asserting md5,
  and the test would fail for a reason nobody cares about.

This is the trade the doctrine asks you to make consciously: a PGlite instance costs real time, and
it is worth it *here* because the behaviour under test is what a query returns. It is not worth it
for the `if` statement that turns a status into a label.

---

## 3. Before / after: a refusal suite that could not fail

**Before** — the event is missing the fields the gate reads:

```ts
const event = (roles) => ({ locals: route(roles) });   // no cookies, no fetch

it('refuses an ordinary member', async () => {
	expect(await post(['employee'], { action: 'organization', profile: HOSTILE })).toBe(403);
});
```

The handler throws `TypeError: Cannot read properties of undefined` before reaching the gate, the
helper maps the throw to a status, and the case passes. So does every other case. So would every
case against a handler with no gate at all.

**After** (`norbital/apps/colony/tests/hosting/operations-authority.test.ts`):

```ts
// :143 — "the signed route, the session cookie a browser sends, and the `fetch` the credential is
//         resolved through. Nothing else on the event is consulted"
const event = (credential, roles, request) => ({
	locals: route(roles),
	cookies: { get: (name) => (name === OPERATOR_SESSION_COOKIE ? credential : undefined) },
	fetch: identityFetch,
	request
});

it('refuses an ordinary tenant member the organization write, and stores nothing', async () => {
	expect(await post('session-employee', ['employee'], { action: 'organization', profile: HOSTILE }))
		.toBe(403);
	// :193 — "The assertion that fails if the gate is removed: without it the write lands, and this
	//          reads back the hostile profile instead of the absent record."
	expect(await organizationProfile()).toMatchObject({ _tag: 'None' });
});

// :307 — the case without which every refusal above is satisfied by a handler that refuses everybody
it('accepts an administrator, and the profile it wrote is the profile stored', async () => {
	expect(await post('session-administrator', ['employee'], { action: 'organization', profile: HOSTILE }))
		.toBe(202);
	expect(await organizationProfile()).toMatchObject({ _tag: 'Some', value: JSON.stringify(HOSTILE) });
});
```

Four transferable moves:

1. **Construct the fields the subject reads, and only those.** More of a framework object is a test
   about the framework.
2. **Assert the effect as well as the status.** A 403 that still writes passes a status-only check.
3. **Include the admission case.** Without it the suite is satisfied by "refuse everything", which
   includes "crash".
4. **Include the discriminating case.** `:217` `refuses a caller whose signed context claims admin
   but whose session does not` is the one case every predecessor of this gate would have admitted —
   it is the test that names what changed, and it goes red the moment the roles array is believed
   again.

---

## 4. Before / after: `toHaveBeenCalled` gains a behavioural partner

**Before:**

```ts
it('surfaces a transport failure', async () => {
	const onError = vi.fn();
	const client = createSyncClient({ transport: failing, sink, onError });
	await client.drain();
	expect(onError).toHaveBeenCalled();
});
```

Green against a client that reports the error *and* corrupts its cursor, applies a partial batch, or
advances past the failed diff. The thing anyone actually cares about is untested.

**After** (`oss/packages/bolt/tests/client/replica.test.ts:187`):

```ts
expect(await client.drain()).toBe(0);       // nothing applied
expect(onError).toHaveBeenCalled();          // the port fired
expect(client.cursor()).toEqual(ORIGIN_CURSOR);  // and the cursor did not advance
```

The middle line is now the least important of the three, which is the correct ordering. Note also
`:159`, `expect(onAdvance).toHaveBeenCalledWith({ xid: 1, sequence: 1 })` — when you do assert on a
callback, assert the *value*, because the value is the contract and the call is not.

The counting double in `norbital/apps/colony/tests/facilities/transport.test.ts:191` is the other
legitimate form: `opens` is incremented inside the injected handler so the test can assert
`expect(opens).toBe(1)` after two identical calls. Here the count **is** the behaviour —
idempotency is not observable any other way.

---

## 5. Component tests: exercise the machinery, not the page

`oss/packages/bolt/tests/ui/collection-navigation.test.ts` is the model. It has four `describe`
blocks and not one of them renders a page:

| `:26` `route context`         | which app a URL belongs to, and what has no context at all |
| `:55` `detail stack placement`| append, replace-in-place, truncate-to-parent, collapse, pop |
| `:108` `detail surface service` | reopening a nested surface does not grow the URL; the stack parameter disappears when the last surface closes |
| `:133` `record detail fields` | which fields a record detail resolves |

Every case is about a decision the navigation machinery makes. None asserts that a component
rendered, that a field is present, or that the People page shows a table. A redesign does not touch
this file; a bug in stack truncation does.

The generalisation: **find the decision inside the component and test that.** If the component has no
extractable decision, it has nothing worth a test — and if the decision cannot be extracted, that is
a design finding, not a reason to start asserting on markup.

---

## 6. Choosing an integration test on purpose

Three in this repository, each with a reason no unit test can supply:

- `norbital/apps/colony/tests/facilities/database-fork.test.ts` — that a fork of a Postgres database
  is a copy with no shared history. Gated on a configured URL (`:78`), and `it.live` because it waits
  for a template to fall quiet (`:100`).
- `norbital/apps/colony/tests/e2e/transports.test.ts` — WebSocket and SSE framing, cancellation
  ordering, and static asset bytes, against a **real production build** that it shells out to
  produce. This is the only kind of test that catches a dev/prod divergence, which is a class this
  codebase has shipped: a registry that populated under the dev server and was empty in the built
  artifact, under a fully green suite.
- `oss/packages/bolt/tests/identity/workspace-access.test.ts` — see §2.

Each is one file, gated or bounded, and none of them is testing a rule that a unit test could have
reached. If your integration test's assertions would still be true against an in-memory double, it
should be a unit test.

---

## 7. Reading a suite for deletion

Walk the file and ask, per test:

| Signal                                                       | Verdict                                |
| ------------------------------------------------------------ | -------------------------------------- |
| Asserts a value exists, is defined, is truthy, has a length  | Delete, or replace with a value assertion |
| Asserts a shape the compiler already enforces                | Delete                                  |
| Names markup, a page, or a component's DOM                   | Delete; move the decision under test    |
| Only assertion is `toHaveBeenCalled`                         | Rewrite to assert state, or delete      |
| Duplicates a behaviour already covered in this file or another | Delete the weaker one                 |
| Its subject has no production caller                         | Delete both                             |
| You cannot name the edit that turns it red                   | Delete                                  |
| Green because the subject threw                              | Fix the input, then check it still passes for the right reason |
| Restates a rule, with no note that it does                   | Add the note, or drive the real rule    |

When the answer is "delete", say what stops being checked in the commit message. If nothing stops
being checked, that is the strongest possible reason to delete it.
