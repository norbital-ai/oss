# Hooks

**What this pillar protects:** that authored hook code gets exactly the capabilities its phase can
safely offer, and no more.

## Why these tests exist

A collection hook runs _inside_ the mutation transaction. Anything it does that leaves the database
— sending a notification, calling an external service — either escapes a transaction that may still
roll back, or holds that transaction open across the network. Both are silent: the hook returns, the
write succeeds, and the damage is either a message about a change that never happened or a lock held
for the length of someone else's outage.

The restriction is therefore structural rather than advisory, and the test asserts the structure:

| File                        | Owns                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hook-api-boundary.test.ts` | Before- and after-hook APIs expose exactly `db` and `readFileAsset`; the real `db` is carried through rather than copied; the restricted API is built by naming fields, never by spreading the source. |

That last clause is the one that matters most over time. A spread would silently re-admit every
capability added to the source API later, so the boundary is proved to be a whitelist.

## Hook behaviour is asserted where it is observable

Ordering, rollback and refusal are properties of the mutation that runs them, so they are owned by
the pillar that owns the mutation:

- before-hook rejection rolling back an optimistic create — `../sync-engine/sync-e2e-comprehensive.test.ts`
- delete hooks running once per record in caller order, and a throwing before-hook rolling back the
  whole batch — `../mutations/delete-many.test.ts`
- approval lifecycle hooks on a terminal decision — `../access-control`

Re-asserting them here would be a second mock of the same boundary.

## Not here

Automation handlers, which run post-commit and outside any transaction, and therefore _do_ get the
external-delivery capabilities. See [`../automations`](../automations/README.md).
