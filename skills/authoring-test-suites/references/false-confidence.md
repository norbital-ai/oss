# False confidence: the catalogue

Each entry is a way a suite can be green while the thing it names is broken. Every one of them has
happened in this repository. Citations give `file:line` plus a quoted anchor — this tree moves, so
search the phrase if the line has drifted.

The common shape: **the test measured something other than what its name claims.** When you review a
test, the question is never "does it pass" but "what would have to change for it to stop passing".

---

## 1. The test that crashed before it reached the subject

`norbital/apps/colony/tests/hosting/operations-authority.test.ts` asserts that `/api/operations`
refuses callers who are not administrators. Every case in an earlier version was throwing
`TypeError: Cannot read properties of undefined` — the constructed SvelteKit event carried no
`cookies` and no `fetch`, so the handler died in the first line of the gate. Each case caught the
throw, mapped it to a status, and got the refusal it expected.

The file was **passing on nothing**. Delete the gate entirely and it would still pass. Delete the
handler and it would still pass.

Two structural defences, both now in that file:

- **A case that must be admitted.** `:307` `accepts an administrator, and the profile it wrote is
the profile stored` — its comment says it plainly: "The gate has to still let the two people who
  administer this workspace through, or the tests above would pass just as well against a handler
  that refused everybody."
- **An assertion on the effect, not the status.** `:193` reads the control store back, because "a
  refusal that returned 403 while still writing the record would pass a status-only assertion".

**Rule.** Every refusal suite needs an admission case. Every status assertion needs a state
assertion beside it. And if a test constructs an input, construct the fields the subject actually
reads and say which ones those are (`:143`).

---

## 2. The fixture that described a system that does not exist

`subjectFromRow` decides administration from one column and nothing else:

```
oss/packages/bolt/src/runtime/identity/identity.ts:76
	admin: IdentityRows.text(row, 'status') === ADMIN_STATUS,
	// "Exactly one spelling counts. A column that is null, absent, misspelled or holding anything
	//  else at all is an ordinary user"
```

The vertical-slice suite's subject fixture stands in for the `bolt_auth_user` row that query returns.
When that fixture carried authority as `admin: true` or as `roles: ['admin']` instead of
`status: 'admin'` (`oss/packages/bolt/tests/runtime/vertical-slice.test.ts`), seven tests believed
they were exercising an administrator and were silently authenticating as an ordinary user.
The suite was green, the cases were named for admin behaviour, and none of them touched the admin
path.

This is the general failure recorded as _fixtures must match the real API_: a fixture written from
what the code expects, rather than from what the system returns, makes a green suite prove a false
premise. It has happened here against an external API too — a fixture described a sandbox provider
as returning memory and CPU at the top level when it has never returned that shape; the check read
absent fields, failed closed on every real template, and CI stayed green while staging returned 500
on every request.

**Rule.** A fixture standing in for a row, a response, or a payload must be checked against the thing
that actually produces it — the query's `select` list, the vendor's docs, a real response. Where a
shape has burned you, keep a case that pins the _wrong_ shape to failing so it cannot drift back.

---

## 3. The column the projection never selected

`workspaceAccess` reports whether each member administers the workspace. It read the role array, and
`admin` is not a role any workspace declares:

```
oss/packages/bolt/src/runtime/identity/identity.ts:586
	// "The status column, not the role array. `admin` was never a role a workspace declares and is
	//  now explicitly not one, so the old test could only ever have matched a row somebody had
	//  hand-written the string into; every real administrator was listed here as `basic`."
```

The same projection then omitted `status` from its `select` — and a column a query never asked for
reads as absent, which is exactly `normal`. **Every administrator in every workspace was reported as
an ordinary member, silently.**

No amount of mocking catches this. A double returns the row the test author imagined, **including the
column the real query forgot to ask for.** The only thing that catches it is a real database
answering a real query — which is why the workspace-access suite runs against PGlite and seeds
`bolt_auth_user` rows with SQL rather than handing the service a literal.

Note that the real database is necessary and not sufficient. That suite used to seed authority into
the wrong column — `workspace-access.test.ts` wrote the string `admin` into a `roles` array, which
nothing in production ever did — so it pinned a mapping the source did not perform, with PGlite
underneath it the whole time. Getting the database into the test buys you nothing if the row you
write is one the system cannot produce. It is seeded as `status` now, and `bolt_auth_user` has no
`roles` column left to write into: a person's authority is their `status`, and their policies come
from the one team `team_id` names. See [worked-examples.md](worked-examples.md) §2.

**Rule.** When the behaviour is "what the database gives back", the database has to be in the test.
That is what integration tests are for, and it is a short list: constraints, cascades, indexes,
generated columns, `select` lists, migrations, query plans.

---

## 4. The negative assertion that never looked

A scan that passes when it finds nothing also passes when it scanned nothing. Colony's architecture
test says so in its own header and defends against it:

```
norbital/apps/colony/tests/architecture/dependencies.test.ts:13
	"Every scan below is a *negative* assertion: it passes when it finds no offender. A scan that
	 walked the wrong directory would therefore find nothing and pass for the wrong reason — the
	 failure mode that survived `src/lib/colony` being unnested to `src/lib`. Asserting a floor on
	 the file count first turns a stale root into a red test instead of a silent no-op."
```

`scanned(files, atLeast)` (`:18`) asserts a minimum before filtering. Compare
`oss/packages/bolt-server/tests/architecture/dependencies.test.ts:28`, which runs the same class of
check with no floor: move or rename `src` there and the test goes green forever.

The non-test version of this mistake is the same mistake. A negative was once concluded from
grepping logs for `created neon project` when the code emits `Creating Neon project`; five projects
had been created and the run was reported as having created none.

**Rule.** To establish that something did not happen, assert a positive artifact — a count, a
version, a stamp, a file that something demonstrably writes — not the absence of one pattern.

---

## 5. The checker that was never mutated

A green result from a checker that has only ever run on clean code is not evidence. A fixture-shape
probe was reported as having independently caught a bug; it had only been run after the fix, and
mutation testing later showed it never fired at all — the traversal handed array callbacks
unproxied elements and was blind below every array.

Relatedly, a scanner is only meaningful for the defect classes it can structurally see. An audit
inspected `<Column>` and `<Field>` nodes in Svelte source and therefore could not see fields
synthesised at runtime, hand-rolled inputs inside custom renderers, or a `recordLabel` declared as a
string array in a model file. Nine collections shipped editable raw-uuid forms under a green audit.

**Rule.** Before trusting a check, reintroduce the defect and watch it go red. A rule that only ever
confirms what you already believed has demonstrated nothing — expect it to disagree with your hand
list in both directions.

---

## 6. The assertion that only proves the wiring

`expect(handler).toHaveBeenCalled()` is true of a system that did the work, and equally true of one
that called the collaborator and then discarded the result, threw, or wrote to the wrong table. It
constrains the test, not the code.

The two legitimate uses in this repository both pair it with a state assertion:

```
oss/packages/bolt/tests/client/replica.test.ts:189
	expect(onError).toHaveBeenCalled();
	expect(client.cursor()).toEqual(ORIGIN_CURSOR);   // the behaviour: the cursor did not advance
```

`onError` is a callback the caller passes _in_ — an output port of the subject, not a collaborator
it reaches out to — so its firing is part of the contract. Even so, the assertion that carries the
test is the next line.

**Rule.** Assert the state that resulted. Where a sequence is the behaviour, record it and assert
the recorded sequence
(`templates/hr-payroll/src/collections/payroll_runs/payslip-sources-lock.test.ts:222` records what
`clearRunResults` deleted and asserts it was the run's payslips and only those — their source rows go
by the database's own cascade — and then asserts another run's payslips survived).

---

## 7. The restatement that drifts

A test that reimplements the rule it is checking passes forever against its own copy.
`templates/hr-payroll/src/lib/policy_grants.test.ts` does exactly this — and is in this skill as the
_good_ example, because of how it handles it:

```
:11  "  - `policiesHeldByTeam` — `teamsByFoldedName.get(teamName.toLocaleLowerCase())`, then each name
                                it yields kept only when `declaredPolicies.has(folded)`. So a policy is
                                held when a team in the subject's `teamPath` declares its `name`, with
                                both team names and policy names folded."
:19  "The restatement is the known weakness: if the runtime's matcher changes, these keep passing
      against a stale copy. It is three lines rather than three hundred for exactly that reason,
      and each one is quoted so the drift is visible in a diff of either side."
```

Three properties make the trade-off acceptable: the restatement is minimal, each line is quoted from
the source it copies, and the weakness is stated in the header where the next reader will see it.

**And the weakness fired.** That header used to restate `subjectHasPolicy` as
`const roles = policy.roles ?? [policy.name]`. `PolicyDeclaration.roles` no longer exists — a policy
is selected by its `name` and by the teams that declare it in `src/access/+teams.ts`, and nothing else — so
for as long as the rename went unnoticed those assertions were passing against a copy of a rule the
runtime had stopped performing. The restatement is exactly what made that visible in a diff instead
of invisible in a green run, which is the argument for the discipline rather than against it.

**Rule.** Prefer driving the real rule. If you must restate it, keep the restatement to a line, quote
its origin, and write down that it can drift. A documented weakness is a maintained test; an
undocumented one is a trap.

---

## 8. Plausible emptiness

`toEqual([])` passing is not proof of a correct empty state. It is equally consistent with a query
that failed, a filter that matched nothing because it was built wrong, or a fetch that returned 500.
A payroll surface once reported "0 claim entries" and "No data available yet" while the endpoint
behind it was returning 500 on every load and the tenant had 88 claims.

**Rule.** When a test asserts emptiness, make the same test prove that the path ran — a call count, a
recorded query, an assertion on the non-empty case immediately beside it. An empty result is a
finding to verify, not a result to accept.

---

## 9. Coverage that only exists to keep code alive

If a function's only caller is its test, the function is dead and the test is what is concealing
that. Colony's plugin suite retired such a helper and now builds the invocation the way the route
does:

```
norbital/apps/colony/tests/plugins/plugins.test.ts:68
	"`DataBrowser.query` was that helper and had no caller: `/api/plugins/[plugin]` builds the same
	 `Plugin` invocation inline, so the helper was a second way to say one thing, kept alive by this
	 test alone. What the test is actually for is the seam below."
```

**Rule.** When you delete a test, check whether anything it referenced is now unreferenced. When you
write one, check that the thing you are calling has a production caller.

---

## 10. A green run that was never actually run

A gate can fail while the surrounding process reports success — a pipe swallows the exit status, a
notification fires on completion rather than on outcome, a `skipIf` probe is subtly wrong so the
suite silently skips forever, or a test file lives in a directory the runner's glob does not name.

**Rule.** Trust exit codes. Confirm that a gated suite has run at least once in an environment that
can run it. Check the runner's `include` globs before assuming your new file is in the suite.

---

## The one-line test

For every test you write or review: **name the edit that turns it red.** If you cannot, you have
written documentation with a `describe` block around it — and documentation that is enforced by
nothing is the most expensive kind, because it looks enforced.
