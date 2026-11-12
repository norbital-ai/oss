# Syncs: files and integrations

A model's `syncs` declares exchange with files or remote systems. All read/write/parser callbacks
live on that sync inside `model(spec)`. [Integration definitions](./integration-providers.md)
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
      const data = yield* decode_customer_page(page);
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
      const saved = yield* decode_customer_receipt(answer);
      return { $id: saved.id, $version: saved.updated_at };
    }
  }
}
```

The example's decoders are provider-specific ordinary helpers. `read` returns rows and cursor,
with `more` for pagination; `$id` is remote identity, `$version` orders changes, `$deleted` deletes.
Only returned fields are synced; the model's other fields stay local. The engine namespaces remote
identities by sync and instance. Each active runtime account reads independently, and local changes
fan out to every active account of that integration. Each replica keeps its own remote id, version,
outbox order and acknowledgement. Model refs do not select destinations.

The engine commits a page's rows and cursor together. Retried reads deduplicate. Numeric sequences and ISO timestamps order versions, so a stale ordered
version never overwrites a newer one. Opaque ETags detect equality and protect `If-Match` writes;
they do not carry chronology ([HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.8.3)).
With ETags, fetch the current remote state on a webhook hint. A provider delivering row data directly
must supply a monotonic sequence or timestamp to reject out-of-order changes. Snapshot completion reconciles missing rows. Partitions keep separate
cursors; expired history starts a new snapshot. Returned `health` reports lag or retention risk.
A page with no rows, no deliveries and an unchanged cursor commits nothing, so a quiet source leaves the
database asleep.

`every` is how often a slot reads, except over a conversation or `items` driver: hints bring that news, so
a healthy sync reads once a day as a backstop and rests until the next UTC midnight, and a failing one keeps
its own shorter rest.

A verified webhook is stored before acknowledgement and wakes that connection's reads, debounced, when the
definition has a read sync. With none, nothing is stored and the delivery is still answered 200.
`read` receives one payload for its driver: `cursor`, fetched `items`, or stored `deliveries`.
A lost webhook
is caught by the next periodic read; duplicate deliveries are acknowledged once.

A read applies rows through the ordinary write path. A locked row refuses an incoming delete, and
an update that changes a field its lock does not exempt; the refusal fails that page, which retries
like any other failed read.

`write` receives the committed operation, row, changed fields and previous remote identity/version.
It returns the acknowledged identity/version, or `null` for local-only changes. The engine never
calls it for that sync's own changes and automatically adds `Idempotency-Key` to requests.
Writes wait for approval, queue transactionally after commit, coalesce per row and retain FIFO
ordering. Retries use exponential backoff with jitter, up to 8 attempts over about 6 hours, then
move to dead letter with Replay. Remote conflicts or refusal restore the last acknowledged row
and expose the failure; a connection's `rate` paces requests and honors `Retry-After`.

SQL writes retain the locally committed record: transient SQL failures retry while the verified
connection is active, and permanent failures become dead letters. In **Settings → Integrations**,
an operator who may update the instance can replay a dead letter or retire that specific write.
Retirement marks only a dead write as skipped, retains its payload and original error, records the
operator and time, and wakes later writes for the record. It neither cancels an in-flight request nor
undoes a remote commit. Resolve the remote state before retiring; replay always uses the saved payload.

## Files

A plain sheet needs no code: headers use catalogue captions or field names, writable columns define the schema,
and the unique constraint marked `import_key: true` matches existing rows.

```ts
syncs: { sheet: { with: 'file', parser: ['xlsx', 'csv'] } }
```

For an external layout, declare `schema` and typed `context`, then map its parsed records:

```ts
syncs: {
  work_sheet: {
    with: 'file', parser: ['xlsx', 'csv'],
    schema: {
      employee_number: { kind: 'text' },
      work_date: { kind: 'date' }
    },
    context: { company: { kind: 'ref', to: 'companies' } },
    read: function* ({ records, context }, ctx) {
      const known = yield* sheet_known(records, context, ctx);
      return {
        rows: records.flatMap((r) => sheet_row(r, known) ?? []),
        findings: sheet_findings(records, known)
      };
    },
    write: function* ({ context }, ctx) {
      return yield* roster_records(context, ctx);
    }
  }
}
```

Column captions live in the flat message catalogue, including a file sync's explicit schema:

```ts
export default {
  'models.work_logs.fields.employee_number': 'Employee',
  'models.work_logs.syncs.work_sheet.schema.fields.work_date': 'Work date'
};
```

For an explicit schema, a header uses `models.<model>.syncs.<sync>.schema.fields.<field>`,
then `models.<model>.fields.<field>`, then the raw field name. Without a schema, it uses the
model field caption, then the raw name. Captions resolve from the base catalogue and the
workspace locale's exact match, or its language when no exact match exists; catalogue values
must be strings. File schemas do not declare inline `label` or `help` text.

XLSX/CSV/TSV exports and templates use those captions. Built-in imports accept either a
caption or a field name, case-insensitively; a raw field name wins when it matches another
column's caption. JSON exports keep raw field keys, and parser/read/write callback records
always use the raw schema field names. Custom parsers return those names themselves.

`$at` identifies the source row or line. Findings use `{ at, field, message, severity }`, where
severity is `warn` or `refuse`. An import is one step: a refusal writes nothing; otherwise the file
is imported and its warnings are reported with the counts. The whole import commits atomically. `scope: { by, range? }` declares a complete
snapshot for reconciliation. Returned rows still run the model's write callbacks.

File callback reads through `ctx.query` retain the importing or exporting caller's authority
and outputs. Context narrows/defaults the operation; it never elevates
authority. Remote sync reads instead use trusted workspace authority.

The toolbar supplies Import, Export and Download template. `write` returns records for export;
without it, the view's rows are exported through the schema. A document export instead returns
`{ document: { html }, name }`; see [documents](./documents.md). A page uses the native
`ctx.sync_control('model', 'name', { mode: 'import', file, context })` or
`{ mode: 'export', context, format? }` (documents use `to`). The returned handle retains the run id
for progress and file download. These controls are not automation callables and cannot be scheduled
through `ctx.run` or `ctx.schedule`. The agent uses its separate `sync` tool.

Remote "Sync now" requires a readable model and `capabilities: { syncs: ['model.sync_name'] }`,
or administrator authority. File imports use the caller's create/update grants; templates and exports
use their read grants. Periodic remote reads and verified webhook hints remain engine-owned.

Built-in parsers are `xlsx`, `csv`, `tsv`, `json`, `ics` and `txt`. The parser list is exactly what
uploads accept. XLSX handles date/time serials; CSV/TSV handle encoding and delimiters; JSON accepts
rows or `{ records }`; ICS reads VEVENTs. `txt` is the line-oriented format for bank and fixed-width
files: export concatenates each record's declared columns in order with no separator, one line per
record, so the `write` body owns the field padding and fixed layout; import reads each non-empty
line into the first declared column. A custom parser is
`{ type: '<registered IANA media type>', extensions: ['.ext'], parse: function* (file, ctx) { … } }`.
Its body has the same 3 s CPU budget. Remote syncs map their data directly and do not use parsers.
