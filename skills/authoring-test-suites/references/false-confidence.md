# False confidence

A green suite proves only what its assertions observe. For each case, name the production edit
that would make it fail. If removing the rule leaves the test green, it is not covering that rule.

## 1. Refusal before the subject ran

A malformed request or incomplete event fixture can fail before authorization, then a broad catch
turns that crash into the expected refusal. Include an admitted caller through the same route and
assert the resulting state. For a refused mutation, assert both the refusal and the absence of a
write. Distinguish an explicit denial from an exception.

## 2. Fixtures for a system that does not exist

Check a row fixture against the declaration and the actual producer. Current Bolt members use
`sys_user.kind`, `active` and the boolean `admin`; neither a `roles` array nor a `status: 'admin'`
string grants administration. Policy authority follows compiled source team-policy links and
actual member affiliation. Do not seed runtime assignment objects to describe a retired contract.

For external payloads, use the vendor's published shape or a permitted captured response. A
convenient double that answers the fields the consumer wishes existed can hide a production bug.
Include a wrong-shape case where that defect class matters.

## 3. A projection the real query never selected

A double can supply a field the production read's `fields` omitted. When the behaviour is what the
query returns, run the real query against a database and seed rows through the current schema.
A database test is still false confidence if it seeds authority or state into obsolete columns.
Assert the projected answer and an opposite case, not only successful execution.

## 4. Absence instead of presence

A source grep or "the old feature is gone" test is not a test: a lint rule checks source, and
deleted code stays deleted. For an operation, verify a positive artifact such as the recorded
request or affected row rather than concluding from a missing phrase.

## 5. A checker never challenged

A new lint rule or compiler check must be exercised against a representative defect. Introduce the
bad shape in an isolated fixture and verify the check rejects it.

## 6. Wiring instead of behaviour

`toHaveBeenCalled()` proves dispatch, not that the result was used or the correct row changed.
Assert state, returned value, refused input or recorded sequence. A callback supplied into the
subject can be an observable output port; pair its invocation with the resulting state. An
ordering test should assert the recorded order, not just the number of calls.

## 7. A second copy of the rule

A test that reimplements grants, routing, calculation or synchronization can stay green while the
runtime changes. Drive the production path. In particular, verify source policy links and approval
routing using the current compiled source bindings and member identities rather than a helper
restating them. Use the actual native identity/approval suites after the access-control migration;
a test of a retired assignment or fallback API is historical evidence, not the final contract.

If a tiny restatement is unavoidable, identify its production origin and its limitation. Do not
quote an obsolete implementation as the current contract.

## 8. Plausible emptiness

An empty list can mean a correct filter, failed transport, missing authority or a swallowed error.
Pair the empty case with a populated case through the same path. Inspect the request's outcome and
render loading and failure separately from the empty state. A calendar or inbox list reporting
zero does not prove that all configured entries were read.

## 9. Tests keeping dead code alive

A helper whose only caller is its test is not production coverage. Inspect its actual callers.
When deleting a test, check whether its subject has become unused; when adding one, verify that
production uses the entry point being tested. Remove redundant helpers instead of exporting them
solely to make them testable.

## 10. A green command that never ran the gate

Check the process exit code, runner include globs, skipped cases and output. A pipe can swallow a
failure and a permanently skipped integration case is not evidence. Verify a required suite ran
in a capable environment.

## 11. A complete-looking partial page

A table page is not the entire collection, and a filtered child list is not the entire relation.
Use data beyond the page boundary to test counts, notifications, selection, nested writes and
stream progress. Assert that unloaded records survive edits and that a full-read path either
returns the complete result or reports its explicit bound. Never mask a silent truncation by
raising the fixture's expected count down to the cap.

## Probes complement tests

Probes are uncommitted `.tmp/` scratch. Exercise an actual built artifact: find a record, perform
the task, inspect the persisted result, and check an invalid or unauthorized change. For UI, inspect
desktop and narrow layouts, long content, empty and loading states. A plausible screenshot is not a
successful write. Keep sensitive seed-bank content out of transcripts, screenshots and reports.
