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

## Known gap: the hosted platform does not drive the drain

The standalone Pod host pumps the change feed on every scheduler sweep. Core does not: it schedules
cron automations through pg-boss and has no per-tenant drain, and the workspace manifest does not yet
project collection-event triggers, so Core cannot tell which tenants would need one. Until that is
wired, collection-event automations run under the standalone host and in this suite but not on the
hosted platform. This is written down rather than skipped, because a skipped test would read as
coverage.

## Not here

Export/import pipelines, which are request-scoped rather than triggered — see
[`../pipelines`](../pipelines/README.md). Notification delivery from an automation is owned by
[`../notifications`](../notifications/README.md).
