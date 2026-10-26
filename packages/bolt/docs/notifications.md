# Notifications

A model's `notify(event, ctx)` returns notices after committed write and approval events. It can
read with workspace authority through `ctx.db.query`, has no I/O and cannot fail the write.
Delivery is retried in the outbox. `ctx.notify` in an automation accepts the same shape.

```ts
notify: function* (event, ctx) {
  if (event.kind !== 'write' || event.action !== 'create') return [];
  return event.records.map((record) => ({
    title: 'New project',
    description: `${record.title} is waiting on the board.`,
    to: [{ team: 'project_reviewers' }],
    via: ['whatsapp'],
    attachments: record.brief === null ? [] : [record.brief],
    link: { collection: 'projects', id: record.id }
  }));
}
```

Write events carry `{ kind: 'write', action, records, previous, actor }`, where action is a write
verb. Approval events carry `{ kind: 'approval', move, step, steps, done, request,
records, requester, approvers }`; moves include request, approve, reject, requestChanges, resubmit
and supersede. Ordinary code decides wording, grouping, plurals and which events should notify.

A notice has `title`, optional `description`, `to`, optional `via`, `attachments`, `link` and `once`.
Recipients are `{ team }`, `{ user }` or `{ policy }`; model approval notices may also name
`'requester'` and `'approvers'`. Inbox delivery is automatic. `via` names declared conversation
connections and is checked at author time. Attachments may be stored files or
`{ document: { html }, to: 'pdf', name: 'Invoice.pdf' }`, converted during delivery. A link defaults
to the event's record. `once` deduplicates notices from retried business work.
