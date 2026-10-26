// A model's syncs (spec §3): `model(…, { syncs: { <s>: FileSync | RemoteSync } })`. A sync says "these rows are exchanged
// with X": a file someone uploads or downloads, or another system through an integration instance. The author writes at
// most two adapters, `read` (theirs → model rows) and `write` (one committed change → a call to them); the engine owns
// the inbox, id map, version guard, outbox, retries, rate, rollback and health. Bodies are typed from the generated
// names, so `S` (the sync's name) finds the sync's own data (`with`, `schema`, `context`) in them.
import type { BodyReturn, Clock, Eff, Loose, WorkspaceQuery } from '../ctx.ts';
import type { FacilityFailure, Unavailable } from '../errors.ts';
import type { InputFields, InputOf } from '../fields.ts';
import type { MediaType } from '../media-types.ts';
import type {
	CollectionSpecOf,
	ColumnValue,
	FieldName,
	InstanceId,
	IntegrationName,
	ModelName,
	Row,
	WritableField
} from '../names.ts';
import type { Duration, FileRef, Id, Json, NonEmpty } from '../values.ts';
import type { ConvertSource, Files } from './facilities.ts';
import type {
	ConfigurationOf,
	ConversationOf,
	DeliveryOf,
	DriverItemOf,
	RequesterOf,
	SendInput
} from './integration.ts';

// ── names ──
type SyncsOf<M> = CollectionSpecOf<M> extends { syncs: infer S } ? S : {};
type SyncData<M, S> = S extends keyof SyncsOf<M> ? SyncsOf<M>[S] : {};
// The startable remote reads (`'<model>.sync.<sync>'`) are `SyncCallable` in `../names.ts`.

// ── rows ──
type SyncValues<M> = { readonly [P in WritableField<M>]?: Loose<ColumnValue<M, P>> };
/**
 * One row a sync's `read` returns: the model's writable fields it carries (those are the synced fields; the model's
 * other fields are local and `read` never touches them), plus up to three markers. `$id` is the other side's identity
 * (the engine keeps the id map, so the model needs no external-id field); `$version` its version (`updated_at`, an etag,
 * a sequence). Numeric sequences and ISO timestamps reject older versions; opaque etags only detect equality
 * and guard conditional writes, so their adapter fetches current state rather than replaying unordered row payloads; `$deleted: true` deletes the row. A soft delete is an
 * ordinary field (`{ $id, active: false }`). The engine stamps the instance FK itself.
 */
export type SyncRow<M> = SyncValues<M> & {
	readonly $id?: string;
	readonly $version?: string;
	readonly $deleted?: true;
};
/** A sync's health as `read` reports it: `attention` raises the instance's status (and any automation watching it). */
export type Health = {
	readonly state: 'ready' | 'attention';
	readonly code?: string;
	readonly message?: string;
};

// ── ctx ──
type Failure = FacilityFailure | Unavailable;
type RequestOn<D> = [RequesterOf<D>] extends [never]
	? {}
	: {
			/** A live request through the instance this body runs for; every request in `write` carries `Idempotency-Key`. */
			request: RequesterOf<D>;
		};
type SendOn<D> = [ConversationOf<D>] extends [never]
	? {}
	: {
			/** Sends a message through the instance this body runs for; `write` returns its id as `{ $id }`. */
			send(message: SendInput<D>): Eff<Id<'sys_message'>, Failure>;
		};
/**
 * What a sync body sees: the clock and `db.query` reads. File sync reads honor the caller's grants and masks; remote
 * sync reads use workspace authority. A remote sync over definition `D` also sees the instance's configuration,
 * `request` (request drivers) and `send` (conversation drivers). A sync body writes nothing itself: what it returns
 * is written in one act.
 */
export type SyncCtx<D = never> = Clock & { readonly db: WorkspaceQuery } & ([D] extends [never]
		? {}
		: { readonly configuration: ConfigurationOf<D> } & RequestOn<D> & SendOn<D>);

// ── files ──
/** A built-in parser, run on the host: `xlsx` (row 1 headers match a field's name or `label`, any case; Excel date and
 * time serials become dates and times), `csv` (RFC 4180, encoding and delimiter detected), `tsv` (as csv, with tabs),
 * `json` (an array of records, or `{ "records": [...] }`), `ics` (iCalendar `VEVENT`s). */
export type BuiltinParser = 'xlsx' | 'csv' | 'tsv' | 'json' | 'ics';
/** One parsed record and where it came from: `$at` is its sheet row or line, so findings and refusals point at it. */
export type FileRecord<R = { readonly [field: string]: Json }> = R & { readonly $at: number };
/** What a custom `parse` sees: a file sync's ctx and the uploaded file's bytes or text. */
type ParseCtx = SyncCtx & { readonly files: Pick<Files, 'get' | 'text'> };
/** A file export may embed a stored image or its bytes in the document it returns. */
type FileWriteCtx = SyncCtx & { readonly files: Pick<Files, 'get' | 'image'> };
/**
 * A parser of the workspace's own for one registered media type: the upload must carry one of `extensions`. `parse`
 * runs in the guest under the 2 s CPU budget and returns each record with its `$at`.
 */
export type CustomParser<R = { readonly [field: string]: Json }> = {
	type: MediaType;
	extensions: readonly `.${string}`[];
	parse: (file: FileRef, ctx: ParseCtx) => BodyReturn<readonly FileRecord<R>[]>;
};
/**
 * A problem a file's `read` found: `at` is the record's `$at` (0: the file as a whole), `field` the column. Any `refuse`
 * blocks the file; a `warn` waits for the member to accept it.
 */
export type Finding = {
	readonly at: number;
	readonly field?: string;
	readonly message: string;
	readonly severity: 'warn' | 'refuse';
};
type RecordOf<M, X> = X extends { schema: infer F } ? InputOf<F> : SyncValues<M>;
type ContextOf<X> = X extends { context: infer F } ? InputOf<F> : {};
/** What a file sync's `read` receives: the parsed records (each with `$at`) and the page's context. */
export type FileReadInput<M, X = {}> = {
	readonly records: readonly FileRecord<RecordOf<M, X>>[];
	readonly context: ContextOf<X>;
};
/**
 * What a file sync's `read` returns, written in one act (one refusal refuses the file). `rows` match the model's `key`
 * (`$deleted: true` deletes the match). `scope` makes the file the whole set: per distinct `by` values (and, with
 * `range`, from that group's first to its last `range` value) every stored row the file does not name is deleted in the
 * same act. `related` rows of other models are written in that act too.
 */
export type FileReadResult<M> = {
	readonly rows: readonly Omit<SyncRow<M>, '$id' | '$version'>[];
	readonly scope?: { readonly by: NonEmpty<WritableField<M>>; readonly range?: WritableField<M> };
	readonly findings?: readonly Finding[];
	readonly related?: { readonly [R in ModelName]?: readonly SyncValues<R>[] };
};
/** What a file sync's `write` receives: the page's context. */
export type FileWriteInput<X = {}> = { readonly context: ContextOf<X> };
/**
 * What a file sync's `write` returns for Export and Download template: records (written as each declared parser's
 * format), or one document the Export menu converts to each target `+workspace.ts` declares under `convert.to`.
 */
export type FileWriteResult<M, X = {}> =
	readonly RecordOf<M, X>[] | { readonly document: ConvertSource; readonly name: string };
/**
 * A sync with a file. The view toolbar offers Import (upload), Download template and Export by itself.
 * - `parser`: exactly what an upload may be (the file picker accepts these and nothing else; default `['xlsx', 'csv']`).
 * - `schema`: the sheet's columns, when they are not the model's writable fields (headers are their labels).
 * - `context`: what the page the toolbar sits on passes (an entity, a period); it narrows and defaults, never authorizes.
 * - Without `read`, an import writes the records as rows matched by the model's `key`; without `write`, Export writes the
 *   schema's fields of the rows in view.
 * Imports enter as the member importing, through the model's `create.transform` / `update.transform` and grants.
 * @example
 * syncs: {
 * 	work_sheet: {
 * 		with: 'file',
 * 		parser: ['xlsx', 'csv'],
 * 		schema: { employee_number: { kind: 'text', label: 'Employee no.' }, work_date: { kind: 'date', label: 'Date' } },
 * 		context: { company_id: { kind: 'id', of: 'entity' } },
 * 		read: function* ({ records, context }, ctx) {
 * 			const known = yield* sheetKnown(records, context, ctx);
 * 			return { rows: records.flatMap((r) => sheetRow(r, known) ?? []), scope: { by: ['employment_id'], range: 'work_date' } };
 * 		}
 * 	}
 * }
 */
export type FileSync<M, S extends string = string, X = SyncData<M, S>> = {
	with: 'file';
	parser?: readonly (BuiltinParser | CustomParser<RecordOf<M, X>>)[];
	schema?: InputFields;
	context?: InputFields;
	read?: (input: FileReadInput<M, X>, ctx: SyncCtx) => BodyReturn<FileReadResult<M>>;
	write?: (input: FileWriteInput<X>, ctx: FileWriteCtx) => BodyReturn<FileWriteResult<M, X>>;
};

// ── remote ──
type DefOf<X> = X extends { with: infer D extends IntegrationName } ? D : IntegrationName;
/**
 * What a remote sync's `read` receives. `cursor` is what the last committed page returned (`null` at the start);
 * `partition` the value of the sync's `partitions` list it reads (`null` when it has none); `instance` the instance it
 * runs for; `deliveries` what arrived since the last read (verified webhooks, or a conversation's inbound messages and
 * the delivery reports of messages `write` sent); `items` what a pushing driver (calendar) delivered.
 */
export type RemoteReadInput<D = IntegrationName> = {
	readonly cursor: Json | null;
	readonly partition: string | null;
	readonly instance: InstanceId<D & string>;
	readonly deliveries: readonly DeliveryOf<D>[];
	readonly items: readonly DriverItemOf<D>[];
};
/**
 * One page a remote `read` returns. Its rows and its cursor commit in one statement. `more` reads on in the same run;
 * `snapshot: 'begin'` … `'end'` brackets a full listing, after which the rows it did not see are deleted; `retained:
 * false` (the source lost its history) starts a fresh snapshot; `health` sets the sync's health.
 */
export type RemoteReadResult<M> = {
	readonly rows: readonly SyncRow<M>[];
	readonly cursor?: Json;
	readonly more?: boolean;
	readonly snapshot?: 'begin' | 'end';
	readonly retained?: false;
	readonly health?: Health;
};
/**
 * One committed change a remote `write` sends: the operation, the row as committed, the fields it changed, the other
 * side's `$id` and `$version` from the id map (`null` before the first acknowledgement), and the instance it goes to.
 */
export type SyncChange<M, D = IntegrationName> = {
	readonly op: 'create' | 'update' | 'delete';
	readonly row: Row<M>;
	readonly changed: readonly FieldName<M>[];
	readonly $id: string | null;
	readonly $version: string | null;
	readonly instance: InstanceId<D & string>;
};
/** What a remote `write` returns: the other side's `$id` and `$version` (stamped when acknowledged), or `null` to skip a local-only edit. */
export type RemoteWriteResult = { readonly $id?: string; readonly $version?: string } | null;
/**
 * A sync with another system through integration `with`. `read` only is one way in, `write` only one way out, both
 * keep the two sides equal.
 *
 * **Which instance.** If the model has a ref field to `sys_integration` pinned to this integration
 * (`where: { integration: { eq: '<integration>' } }`), that field picks the instance per row for `write`, and `read`
 * stamps it. Otherwise `read` runs for every active instance, and `write` goes through the one connection
 * `+workspace.ts` names for the integration (`bolt check` refuses an ambiguous one).
 *
 * **When.** `read` runs every `every` (default `'15min'`), straight away (debounced) after a verified webhook, and on
 * "Sync now". `partitions` names a many-valued text configuration field: one cursor per value (calendar ids); a dropped
 * value releases its cursor and id map, and its rows stay. `write` runs from the outbox after each committed change.
 *
 * **Fields.** The fields `read` returns are the synced fields. A read-only sync locks them for everyone else; with
 * `write` they stay editable and every edit is queued. The engine never calls `write` for a change the sync itself made
 * (no echo loops), and every request in `write` carries `Idempotency-Key`. A conversation integration's `write` sends
 * with `ctx.send` and returns `{ $id: messageId }`; the delivery reports reach `read` as `deliveries`.
 *
 * **What the engine handles** (the author writes none of it):
 *
 * | Failure | Handled by |
 * | --- | --- |
 * | A webhook is lost | The next `read` runs by cursor on `every` and catches up; webhooks only make it sooner. |
 * | Webhooks arrive twice | Stored by delivery id; a duplicate is acknowledged and dropped. |
 * | Changes arrive out of order | `$version`: an older version never overwrites a newer one. |
 * | A read or a write is cut off mid-batch | A page's rows and cursor commit in one statement; a write's result is stamped when acknowledged. Either side resumes where it stopped. |
 * | Our system is down | Their retries, then our cursor catches up; queued writes wait in the outbox, inside the database. |
 * | Their system is down or slow | `write` retries with backoff (8 attempts over about 6 h), then dead letter with Replay on the integration page; `read` resumes from its cursor. |
 * | Their rate limit | The connection's `rate` paces every request; a `429` with `Retry-After` is honoured. |
 * | A burst on our side | The outbox queues it, FIFO per row; edits to a row while its write is in flight coalesce into one write of the latest state. |
 * | A duplicate call after a timeout | `Idempotency-Key` on every write request; `$id` and `$version` dedupe on our side. |
 * | Both sides edited the same record | Send `If-Match: $version`: the conflict rolls the local change back to the last acknowledged revision, and the row shows the failure. |
 * | The other side refuses a change | Rolled back the same way (a refused create deletes the row), the row marked failed with their message, the writer notified. |
 * | A webhook subscription silently dies | Health raises "webhooks quiet while reads find changes", beside last read, lag, pending and dead counts. |
 * @example
 * syncs: {
 * 	crm: {
 * 		with: 'crm',
 * 		read: function* ({ cursor }, ctx) {
 * 			const page = yield* ctx.request({ method: 'GET', path: '/customers', query: { since: String(cursor ?? '') }, output: { kind: 'json' } });
 * 			return { rows: toRows(page), cursor: nextCursor(page), more: hasMore(page) };
 * 		},
 * 		write: function* ({ op, row, $id, $version }, ctx) {
 * 			const c = yield* ctx.request({ method: op === 'create' ? 'POST' : op === 'update' ? 'PATCH' : 'DELETE',
 * 				path: $id === null ? '/customers' : `/customers/${$id}`, headers: $version === null ? {} : { 'If-Match': $version },
 * 				body: { name: row.name }, output: { kind: 'json' } });
 * 			return acknowledged(c);
 * 		}
 * 	}
 * }
 */
export type RemoteSync<M, S extends string = string, X = SyncData<M, S>, D = DefOf<X>> = {
	with: IntegrationName;
	every?: Duration;
	partitions?: string;
	read?: (input: RemoteReadInput<D>, ctx: SyncCtx<D>) => BodyReturn<RemoteReadResult<M>>;
	write?: (change: SyncChange<M, D>, ctx: SyncCtx<D>) => BodyReturn<RemoteWriteResult>;
};
/** One sync of model `M` (named `S`): a file or another system. */
export type SyncSpec<M, S extends string = string> = FileSync<M, S> | RemoteSync<M, S>;
