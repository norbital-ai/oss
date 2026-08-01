# Automations

**What this pillar protects:** that a declared automation actually runs, runs once per committed
change, and leaves a record of every run — including the ones that failed.

## Why these tests exist

Automations have two trigger forms and they fail in opposite ways.

A **cron** automation announces itself: if it does not run, a schedule is visibly empty. A
**collection-event** automation (`{ trigger: { collection, event } }`) does not. It is declared,
type-checked, compiled into the workspace, and — unless some host drains the change feed — never
runs at all. Nothing errors. That is exactly the shape of failure these tests exist to make
impossible, and it is why the dispatch test drives a real compiled runtime rather than the matcher
alone.

| File                             | Owns                                                                                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automation-dispatch.test.ts`    | Selection, as pure logic: action → event mapping, collection+event matching, and that schedule triggers never match a change.                                                                              |
| `automation-runtime-e2e.test.ts` | Execution against a compiled CRM runtime: an unknown automation is refused, a committed change dispatches its automation exactly once across repeated drains, and the run is recorded in `automation_run`. |

Exactly-once is asserted by draining twice. The durable cursor in `_norbital_automation_cursor` is
what makes the second drain a no-op; without it a host restart would replay every effect the feed
still holds.

CRM is used because it is the only template declaring a change-feed automation. Construction's are
all cron, and cron dispatch is the host's loop rather than the runtime's.

## Hosted dispatch boundary

Pod projects the required recurring work through `workspaceJobs()`, including the durable
collection-event drain. A standalone host runs those jobs with its local scheduler; Core schedules
and supervises the same job declarations and invokes their Pod-owned implementations through private
host commands. The host decides when work runs, but it does not reimplement matching, cursoring, or
automation execution.

## Not here

Export/import pipelines, which are request-scoped rather than triggered — see
[`../pipelines`](../pipelines/README.md). Notification delivery from an automation is owned by
[`../notifications`](../notifications/README.md).
