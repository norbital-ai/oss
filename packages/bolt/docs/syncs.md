# Syncs: files and integrations

A model's `syncs` declares exchange with files or remote systems. All read/write/parser callbacks
live on that sync inside `model(name, spec)`. [Integration definitions](./integration-providers.md)
provide the connection, authentication and transport.

## Remote system

```ts
syncs: {
  crm: {
    with: 'crm',
    every: '5min',
    read: function* ({ cursor }, ctx) {
      const page = yield* ctx.request({
        method: 'GET', path: '/customers',
        query: { updated_since: String(cursor ?? ''), limit: 200 },
        output: { kind: 'json' }
      });
      // Decode the provider answer once against its schema before mapping it.
      const data = yield* decodeCustomerPage(page);
      return {
        rows: data.items.map((c) => ({
          $id: c.id, $version: c.updated_at, ...(c.deleted ? { $deleted: true } : {}),
          name: c.name, email: c.email
        })),
        cursor: data.next_cursor, more: data.has_more
      };
    },
    write: function* ({ op, row, changed, $id, $version }, ctx) {
      if (op === 'update' && !changed.some((f) => f === 'name' || f === 'email')) return null;
      const answer = yield* ctx.request({
        method: op === 'create' ? 'POST' : op === 'update' ? 'PATCH' : 'DELETE',
        path: $id ? `/customers/${$id}` : '/customers',
        headers: $version ? { 'If-Match': $version } : {},
        body: { name: row.name, email: row.email },
        output: { kind: 'json' }
      });
      const saved = yield* decodeCustomerReceipt(answer);
      return { $id: saved.id, $version: saved.updated_at };
    }
  }
}
```

The example's decoders are provider-specific ordinary helpers. `read` returns rows and cursor,
with `more` for pagination; `$id` is remote identity, `$version` orders changes, `$deleted` deletes.
Only returned fields are synced; the model's other fields stay local. The engine namespaces remote identities by sync and instance. If business keys are account-local,
include the integration-instance ref in those keys too. A pinned instance ref routes each row's
writes; without it, exactly one declared connection supplies the route.

The engine commits a page's rows and cursor together. Retried reads deduplicate. Numeric sequences and ISO timestamps order versions, so a stale ordered
version never overwrites a newer one. Opaque ETags detect equality and protect `If-Match` writes;
they do not carry chronology ([HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.8.3)).
With ETags, fetch the current remote state on a webhook hint. A provider delivering row data directly
must supply a monotonic sequence or timestamp to reject out-of-order changes. Snapshot completion reconciles missing rows. Partitions keep separate
cursors; expired history starts a new snapshot. Returned `health` reports lag or retention risk.

A verified webhook is stored before acknowledgement and wakes that connection's reads, debounced.
`read` also receives stored `deliveries` for providers whose webhook is the data. A lost webhook
is caught by the next periodic read; duplicate deliveries are acknowledged once.

`write` receives the committed operation, row, changed fields and previous remote identity/version.
It returns the acknowledged identity/version, or `null` for local-only changes. The engine never
calls it for that sync's own changes and automatically adds `Idempotency-Key` to requests.
Writes wait for approval, queue transactionally after commit, coalesce per row and retain FIFO
ordering. Retries use exponential backoff with jitter, up to 8 attempts over about 6 hours, then
move to dead letter with Replay. Remote conflicts or refusal restore the last acknowledged row
and expose the failure; a connection's `rate` paces requests and honors `Retry-After`.

## Files

A plain sheet needs no code: headers use field names/labels, writable columns define the schema,
and the model's `key` matches existing rows.

```ts
syncs: { sheet: { with: 'file', parser: ['xlsx', 'csv'] } }
```

For an external layout, declare `schema` and typed `context`, then map its parsed records:

```ts
syncs: {
  work_sheet: {
    with: 'file', parser: ['xlsx', 'csv'],
    schema: {
      employee_number: { kind: 'text', label: 'Employee no.' },
      work_date: { kind: 'date', label: 'Date' }
    },
    context: { company: { kind: 'id', of: 'companies' } },
    read: function* ({ records, context }, ctx) {
      const known = yield* sheetKnown(records, context, ctx);
      return {
        rows: records.flatMap((r) => sheetRow(r, known) ?? []),
        findings: sheetFindings(records, known)
      };
    },
    write: function* ({ context }, ctx) {
      return yield* rosterRecords(context, ctx);
    }
  }
}
```

`$at` identifies the source row or line. Findings use `{ at, field, message, severity }`, where
severity is `warn` or `refuse`. A refusal writes nothing; warnings require accepting and rerunning
the same file. The whole import commits atomically. `scope: { by, range? }` declares a complete
snapshot for reconciliation. Returned rows still run the model's write callbacks.

File callback reads, including declared queries through `ctx.db.query`, retain the importing or
exporting caller's authority and masks. Context narrows/defaults the operation; it never elevates
authority. Remote sync reads instead use trusted workspace authority.

The toolbar supplies Import, Export and Download template. `write` returns records for export;
without it, the view's rows are exported through the schema. A document export instead returns
`{ document: { html }, name }`; see [documents](./documents.md). Start a file run as
`bolt.start('model.sync.name', { mode: 'import', file, context })` or
`{ mode: 'export', context, format? }` (documents use `to`).

Built-in parsers are `xlsx`, `csv`, `tsv`, `json` and `ics`. The parser list is exactly what uploads
accept. XLSX handles date/time serials; CSV/TSV handle encoding and delimiters; JSON accepts rows
or `{ records }`; ICS reads VEVENTs. A custom parser is
`{ type: '<registered IANA media type>', extensions: ['.ext'], parse: function* (file, ctx) { … } }`.
Its body has the same 2 s CPU budget. Remote syncs map their data directly and do not use parsers.
