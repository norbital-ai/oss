// A model's syncs (spec §3): `model({ syncs: { <s>: FileSync | RemoteSync } })`. A sync says "these rows are exchanged
// with X": a file someone uploads or downloads, or another system through an integration instance. The author writes at
// most two adapters, `read` (theirs → model rows) and `write` (one committed change → a call to them); the engine owns
// the inbox, id map, version guard, outbox, retries, rate, rollback and health. Bodies are typed from the generated
// names, so `S` (the sync's name) finds the sync's own data (`with`, `schema`, `context`) in them.
import type { BodyReturn, Clock, Eff, Loose, MessageKey, WorkspaceQuery } from '../ctx.ts';
import type { FacilityFailure, Refusal, Unavailable } from '../errors.ts';
import type { InputFields, InputOf } from '../fields.ts';
import type { MediaType } from '../media-types.ts';
import type {
	ExposureSpecOf,
	ColumnValue,
	FieldName,
	InstanceId,
	IntegrationName,
	AuthoredModelName,
	Row,
	WritableField
} from '../names.ts';
import type { Duration, FileRef, Id, Json, NonEmpty } from '../values.ts';
import type { ConvertSource, Files } from './facilities.ts';
import type { DeclaredConvertTarget } from './names.ts';
import type { Where } from '../where.ts';
import type {
	ConfigurationOf,
	ConversationOf,
	DeliveryOf,
	DriverItemOf,
	DriverReadOf,
	RequesterOf,
	SendInput
} from './integration.ts';

// ── names ──
type SyncsOf<M> = ExposureSpecOf<M> extends { syncs: infer S } ? S : {};
type SyncData<M, S> = S extends keyof SyncsOf<M> ? SyncsOf<M>[S] : {};
/** A native file transfer: import an upload, download a template, or export the caller's view. */
export type FileSyncInput<M, S> = (
	| { readonly mode: 'import'; readonly file: Id<'sys_file'> }
	| {
		readonly mode: 'template' | 'export';
		readonly format?: 'xlsx' | 'csv' | 'tsv' | 'json' | 'txt';
		readonly to?: DeclaredConvertTarget | 'xlsx' | 'csv' | 'tsv' | 'json' | 'txt';
		readonly where?: Where<M>;
	}
) & { readonly context?: SyncData<M, S> extends { context: infer F } ? InputOf<F> : {} };
/** Native controls accept a transfer for a file sync, or an optional connection/partition for a remote read. */
export type SyncControlInput<M, S> = SyncData<M, S> extends { with: 'file' }
	? FileSyncInput<M, S>
	: { readonly instance?: Id<'sys_integration'>; readonly partition?: string };


// ── rows ──
type SyncValues<M> = { readonly [P in WritableField<M>]?: Loose<ColumnValue<M, P>> };
/**
 * One row a sync's `read` returns: the model's writable fields it carries (those are the synced fields; the model's
 * other fields are local and `read` never touches them), plus up to three markers. `$id` is the other side's identity
 * (the engine keeps the id map, so the model needs no external-id field); `$version` its version (`updated_at`, an etag,
 * a sequence). Numeric sequences and ISO timestamps reject older versions; opaque etags only detect equality
 * and guard conditional writes, so their adapter fetches current state rather than replaying unordered row payloads; `$deleted: true` deletes the row. A soft delete is an
 * ordinary field (`{ $id, active: false }`). The engine's id map carries the connection; no routing field is needed.
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
			/** Queues a message through this instance; `write` returns its durable queue id as `{ $id }`, not delivery proof. */
			send(message: SendInput<D>): Eff<Id<'sys_message'>, Failure>;
		};
interface SyncRefusal {
	/** Stops the body with a catalogue key, and the `row` and `field` it names. */
	refuse(message: MessageKey, at?: { field?: string; row?: number }): Eff<never, Refusal>;
}

/**
 * What a remote sync body sees: the clock and `query` reads as the workspace (unscoped), the instance's
 * configuration, `request` (request drivers) and `send` (conversation drivers). A sync body writes nothing itself: what
 * it returns is written in one act.
 */
export type SyncCtx<D = never> = Clock &
	WorkspaceQuery &
	SyncRefusal &
	([D] extends [never]
		? {}
		: { readonly configuration: ConfigurationOf<D> } & RequestOn<D> & SendOn<D>);
/**
 * What a file sync body sees: the clock and `query` reads as the member who started the import or export — each root's
 * granting policies filter its output and layers, so a document shows only what that member may read.
 */
export type FileSyncCtx = Clock & WorkspaceQuery & SyncRefusal;

// ── files ──
/** A built-in parser, run on the host: `xlsx` (row 1 headers match a field's name or `label`, any case; Excel date and
 * time serials become dates and times), `csv` (RFC 4180, encoding and delimiter detected), `tsv` (as csv, with tabs),
 * `json` (an array of records, or `{ "records": [...] }`), `ics` (iCalendar `VEVENT`s), `txt` (one non-empty line per
 * record, read into the first declared column). */
export type BuiltinParser = 'xlsx' | 'csv' | 'tsv' | 'json' | 'ics' | 'txt';
/** One parsed record and where it came from: `$at` is its sheet row or line, so findings and refusals point at it. */
type FileRecord<R = { readonly [field: string]: Json }> = R & { readonly $at: number };
/** What a custom `parse` sees: a file sync's ctx and the uploaded file's bytes or text. */
type ParseCtx = FileSyncCtx & { readonly files: Pick<Files, 'get'> };
/** A file export may embed a stored image or its bytes in the document it returns. */
type FileWriteCtx = FileSyncCtx & { readonly files: Pick<Files, 'get' | 'image'> };
/**
 * A parser of the workspace's own for one registered media type: the upload must carry one of `extensions`. `parse`
 * runs in the guest under the 3 s CPU budget and returns each record with its `$at`.
 */
type CustomParser<R = { readonly [field: string]: Json }> = {
	type: MediaType;
	extensions: readonly `.${string}`[];
	parse: (file: FileRef, ctx: ParseCtx) => BodyReturn<readonly FileRecord<R>[]>;
};
/**
 * A problem a file's `read` found: `at` is the record's `$at` (0: the file as a whole), `field` the column. Any `refuse`
 * blocks the file (nothing is written); a `warn` is reported with what was imported.
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
type FileReadInput<M, X = {}> = {
	readonly records: readonly FileRecord<RecordOf<M, X>>[];
	readonly context: ContextOf<X>;
};
/**
 * What a file sync's `read` returns, written in one act (one refusal refuses the file). `rows` match the model's `key`
 * (`$deleted: true` deletes the match). `scope` makes the file the whole set: per distinct `by` values (and, with
 * `range`, from that group's first to its last `range` value) every stored row the file does not name is deleted in the
 * same act. `related` rows of other models are written in that act too.
 */
type FileReadResult<M> = {
	readonly rows: readonly Omit<SyncRow<M>, '$id' | '$version'>[];
	readonly scope?: { readonly by: NonEmpty<WritableField<M>>; readonly range?: WritableField<M> };
	readonly findings?: readonly Finding[];
	readonly related?: { readonly [R in AuthoredModelName]?: readonly SyncValues<R>[] };
};
/** What a file sync's `write` receives: the page's context. */
type FileWriteInput<X = {}> = { readonly context: ContextOf<X> };
/**
 * What a file sync's `write` returns for Export and Download template: records (written as each declared parser's
 * format), or one document the Export menu converts to each target `+workspace.ts` declares under `convert.to`.
 */
type FileWriteResult<M, X = {}> =
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
	read?: (input: FileReadInput<M, X>, ctx: FileSyncCtx) => BodyReturn<FileReadResult<M>>;
	write?: (input: FileWriteInput<X>, ctx: FileWriteCtx) => BodyReturn<FileWriteResult<M, X>>;
};

// ── remote ──
type DefOf<X> = X extends { with: infer D extends IntegrationName } ? D : IntegrationName;
type ReadPayload<D, Mode = DriverReadOf<D>> = Mode extends 'cursor'
	? { readonly cursor: Json | null }
	: Mode extends 'items'
		? { readonly items: readonly DriverItemOf<D>[] }
		: Mode extends 'deliveries'
			? { readonly deliveries: readonly DeliveryOf<D>[] }
			: never;
/**
 * One payload per driver: a request driver's committed cursor, a pushing driver's fetched items, or messages and
 * delivery reports. Partition and instance identify this read; HTTP webhooks are wake hints, not a second payload.
 */
export type RemoteReadInput<D = IntegrationName> = D extends unknown ? {
	readonly partition: string | null;
	readonly instance: InstanceId<D & string>;
} & ReadPayload<D> : never;
/**
 * One page a remote `read` returns. Its rows and its cursor commit in one statement. `more` reads on in the same run;
 * `snapshot: 'begin'` … `'end'` brackets a full listing, after which the rows it did not see are deleted; `retained:
 * false` (the source lost its history) starts a fresh snapshot; `health` sets the sync's health.
 */
type RemoteReadResult<M> = {
	readonly rows: readonly SyncRow<M>[];
	readonly cursor?: Json;
	readonly more?: boolean;
	readonly snapshot?: 'begin' | 'end';
	readonly retained?: false;
	readonly health?: Health;
};
/**
 * One committed change a remote `write` sends: the replica operation, the row as committed, the fields it changed, the other
 * side's `$id` and `$version` from the id map (`null` before the first acknowledgement), and the instance it goes to.
 * The first send creates an unbound replica or updates a bound one; deletion stays deletion. The selected operation
 * is frozen on the first attempt, so retrying a create keeps the same operation and idempotency key.
 */
export type SyncChange<M, D = IntegrationName> = {
	readonly op: 'create' | 'update' | 'delete';
	readonly row: Row<M>;
	readonly changed: readonly FieldName<M>[];
	readonly $id: string | null;
	readonly $version: string | null;
	readonly instance: InstanceId<D & string>;
};
/** Acknowledges a replica, optionally returning `$id` and `$version`; `null` skips a local-only edit. */
type RemoteWriteResult = { readonly $id?: string; readonly $version?: string } | null;
/**
 * A sync with another system through integration `with`. `read` only is one way in, `write` only one way out, both
 * keep the two sides equal.
 *
 * **Which instance.** Each active connection of the integration reads independently. Every committed change fans out
 * to all connections active at that commit, including a change imported by another connection. Each replica has its
 * own id map, version, outbox order and acknowledgement. A change imported by this sync skips its source connection,
 * unless an older uncertain delivery could overwrite it; then the current image is queued behind that delivery.
 * A model's ordinary refs and `+workspace.ts` slots do not select destinations.
 * Pausing an existing replica stops delivery, while retaining later changes and deletes for its next activation.
 *
 * **When.** `read` runs every `every` (default `'15min'`), straight away (debounced) after a verified webhook, and on
 * "Sync now". `partitions` names a many-valued text configuration field: one cursor per value (calendar ids); a dropped
 * value releases its cursor and id map, and its rows stay. `write` runs from the outbox after each committed change.
 * Active connections initialize existing rows in durable batches. Rows held for approval wait until the request
 * stands or closes; initialization never exports provisional values.
 *
 * **Fields.** The fields `read` returns are the synced fields. A read-only sync locks them for everyone else; with
 * `write` they stay editable and every edit is queued. An imported change is sent to the other active connections,
 * and every request in `write` carries `Idempotency-Key`. A conversation integration's `write` sends
 * with `ctx.send` and returns `{ $id: messageId }`; the delivery reports reach `read` as `deliveries`.
 * Initialization, source correction and peer recovery preserve local history if a destination refuses them. A refused ordinary edit
 * rolls back only while its local revision is still current, then queues the restored image for the other connections.
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
 * 			if (op === 'delete' && $id === null) return null;
 * 			const c = yield* ctx.request({ method: op === 'delete' ? 'DELETE' : $id === null ? 'POST' : 'PATCH',
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
