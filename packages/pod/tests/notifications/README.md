# Notifications

**What this pillar protects:** Pod owns notification records and retry state; the host only supplies
the messaging facility and runs the declared drain job.

| File                            | Boundary proved                                                                                                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notification-channels.test.ts` | Authored external channels must be advertised by the active host.                                                                                                                                   |
| `notifications-menu.test.ts`    | Untrusted replica rows are narrowed before the Pod-owned menu renders them.                                                                                                                         |
| `notification-e2e.test.ts`      | A hook commits the in-app row and external outbox atomically; the host job delivers once, records failure, retries, replicates only to the recipient, and permits only the recipient to dismiss it. |

The end-to-end suite intentionally drives `workspaceJobs()` and a `messaging` binding. It does not
bind an obsolete `notifications` facility or deliver during the author transaction. External
delivery is asynchronous: a provider refusal updates `notification_outbox`, and a later drain may
retry it without rerunning the hook or automation that created the message.

PostgreSQL `NOTIFY` is sync transport, not a person-facing notification. Its coverage belongs to
`../sync-engine/sync-notify-coalescing.test.ts`.
