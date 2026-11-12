# Notifications

A model's per-verb effect calls `ctx.notify` after committed write or approval events. It reads
and acts as the writer, with no independent policies. A failed effect is retried as durable work;
it does not undo the original commit. Automations use the same notice shape under their own policies.

```ts
create: {
  // columns and any transform are declared alongside this effect
  effect: function* (changes, ctx) {
    if (ctx.event.kind !== 'write') return;
    yield* ctx.notify(changes.map(({ after }) => ({
      title: 'New project',
      description: `${after.title} is waiting on the board.`,
      to: [{ team: 'project_reviewers' }],
      link: { model: 'projects', id: after.id },
      once: `project-created:${after.id}`
    })));
  }
}
```

For `ctx.event.kind === 'write'`, the effect receives changes with `before`, `set`, `after` and
`changed(...fields)`. A held write freezes its changes and writer until final approval; rejection
discards them. Approval events have an empty change list and carry `{ kind: 'approval', move, step, steps, done, request,
records, requester, approvers }`; moves include request, approve, reject, request_changes, resubmit,
supersede and withdraw. Ordinary code decides wording, grouping, plurals and which events should notify.

Built-in approval inbox notices already exist. For custom notices, use `to: ['approvers']` in the request event. Delivery resolves the active
request's current step against active staff members, excludes its requester, and sends nothing
after the request closes. The same effect can handle the other approval moves.

A notice has `title`, optional `description`, `to`, optional `via`, `attachments`, `link` and `once`.
`title` and `description` are plain text, stored and shown as written, not message keys.
Recipients are `{ team }`, `{ user }` or `{ policy }`; approval effects may also name
`'requester'` and `'approvers'`. Inbox delivery is automatic. `via` names persisted conversation
accounts, resolved from runtime records and narrowed with `instance_id`; source slots do not exist. Attachments may be stored files or
`{ document: { html }, to: 'pdf', name: 'Invoice.pdf' }`, converted during delivery. A link defaults
to the event's record. `once` deduplicates notices from retried business work.

The native notification menu keeps unread notices visible and groups read notices in a collapsible section.
Opening a record link uses the workspace's native record sheet. Device delivery follows the
same notices through the live lane; see [Device](./device.md).
