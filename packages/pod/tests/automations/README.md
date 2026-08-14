# Automations

**What this pillar protects:** trigger selection is exact, and each handler invocation is one
admitted function.

| File                                      | Boundary proved                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automation-dispatch.test.ts`             | Pure selection: action-to-event mapping, collection/event matching, and exclusion of schedule triggers from the change feed.                        |
| `automation-replay.test.ts`               | Stable AI-effect request identity and replay context after `await infer`.                                                                           |
| `../runtime/automation-hooks-e2e.test.ts` | Compiled-runtime integration: scheduled/event admit, exact-artifact refusal, infer yield/replay, run records, hooks, and atomic terminal mutation. |

The compiled-runtime suite is intentionally cross-pillar because the failure boundary crosses a
committed mutation, the durable outbox cursor, authored code, and its derived write. A second drain
and later non-matching events leave exactly one run and one effect.

Automations are absent from `workspaceJobs()`: that is the infrastructure-cron set. The host admits
authored schedules, collection events, and agent-loop iterations as functions.

Collection-event dispatch has two stages. One bounded function tails the authoritative outbox and
advances `_norbital_automation_cursor`; repeated scans neither lose nor duplicate work. The host
then admits the handler. `await infer` yields; the isolate is disposed; the host runs the model;
DBOS admits a new isolate so terminal writes and success commit atomically. External effects never
belong to the transaction or request that created the collection row.
