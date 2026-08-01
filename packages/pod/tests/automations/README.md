# Automations

**What this pillar protects:** trigger selection is exact, and hosts schedule Pod-owned jobs without
reimplementing matching, cursoring, or execution.

| File                                      | Boundary proved                                                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automation-dispatch.test.ts`             | Pure selection: action-to-event mapping, collection/event matching, and exclusion of schedule triggers from the change feed.                                   |
| `../runtime/automation-hooks-e2e.test.ts` | Compiled-runtime integration: scheduled and event automations, durable repeated drains, run records, hooks, and the mutation/approval transaction around them. |

The compiled-runtime suite is intentionally cross-pillar because the failure boundary crosses a
committed mutation, the durable outbox cursor, authored code, and its derived write. A second drain
and later non-matching events leave exactly one run and one effect.

Pod projects recurring work through `workspaceJobs()`. Standalone hosts run those declarations with
their scheduler; Core supervises the same declarations and invokes private Pod host commands. The
host decides when work runs, while Pod owns what the job means.
