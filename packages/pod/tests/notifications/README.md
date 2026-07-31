# Notifications

**What this pillar protects:** that a notification the workspace believes it sent actually reached a
host, addressed to the caller's own organization, on a channel that exists.

## Why these tests exist

A notification is the one effect with no in-product evidence. A wrong row can be read back; a
message that was never delivered leaves nothing behind. The three ways that happens are all silent:

1. **No channel.** `channels` is optional in the authoring API. If the runtime defaulted to an empty
   list, the message would be composed, reported as sent, and delivered nowhere.
2. **Wrong organization.** The payload names a recipient, and a workspace that could also name an
   organization could address someone else's user. The runtime overrides it with the runtime's own.
3. **Swallowed failure.** A provider outage that is caught and logged looks identical to success
   from the author's side.

| File                                | Owns                                                                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notification-delivery-e2e.test.ts` | Delivery through a real host facility from a compiled runtime: organization scoping, recipient, default `web` channel, and that a provider failure becomes a failed `automation_run` rather than a silent success. |

## Why it runs through an automation

`sendNotification` is only reachable from post-commit code — automations, handlers, after-hooks —
because transactional collection hooks are denied external delivery on purpose (see
[`../hooks`](../hooks/README.md)). CRM's `user_onboarding` automation welcomes a new user, so the
delivery path is exercised by product behaviour rather than by a fixture written to be tested.

The host facility is supplied by the test through `bootPodRuntime(..., { facilities })`. A test that
wants to prove behaviour _without_ a facility simply does not name it; nothing is bound by default
except `db`.

## Known gap

`notifications` is not part of `RuntimeFacilityRequirement`, so a workspace that calls
`sendNotification` declares nothing in its manifest and a host missing the facility is only
discovered at the point of use (a 503). Making it declarable needs manifest-level detection of the
call, which is not implemented.

## Not here

PostgreSQL `NOTIFY`, which is sync transport and has nothing to do with telling a person something.
It is owned by `../sync-engine/sync-notify-coalescing.test.ts`.
