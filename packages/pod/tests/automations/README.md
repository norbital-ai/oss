# Automations

**What this pillar protects:** trigger selection and tenant admission are exact, while DBOS alone
owns automation schedules, recovery and step execution.

| File                                      | Boundary proved                                                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automation-dispatch.test.ts`             | Pure selection: action-to-event mapping, collection/event matching, and exclusion of schedule triggers from the change feed.                                   |
| `automation-replay.test.ts`               | Stable AI-effect request identity and replay context.                                                                                                         |
| `../runtime/automation-hooks-e2e.test.ts` | Compiled-runtime integration: scheduled/event receipts, exact-artifact refusal, AI yield/replay, run records, hooks, and atomic terminal mutation.             |

The compiled-runtime suite is intentionally cross-pillar because the failure boundary crosses a
committed mutation, the durable outbox cursor, authored code, and its derived write. A second drain
and later non-matching events leave exactly one run and one effect.

Automations are deliberately absent from `workspaceJobs()`: that is the non-automation integration /
notification infrastructure set. Core's DBOS scheduler owns authored cron occurrences and a DBOS-owned
reconciliation schedule owns event admission. pg-boss never scans, schedules, or executes automation work.

Collection-event dispatch has two durable stages. Admission records a uniquely keyed immutable receipt
before advancing its tenant cursor; repeated scans therefore neither lose nor duplicate work. DBOS then
runs one billable, two-second-capped guest step at a time. AI stages a stable effect and rolls back
pre-effect writes; Core fences and bills the provider effect, settles its result, and DBOS replays the
handler so terminal writes and success commit atomically.
External effects never belong to the transaction or request that created the
collection row.
