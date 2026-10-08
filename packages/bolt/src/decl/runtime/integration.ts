// `integration()` and `pipeline()` (§3.3.5, P14, rule 23): per-collection sync and feeds. Like `collection`, each
// takes its collection's name, because its field maps are typed against that collection.
import type { CallerReads, Insert, Keyed, QueryCtx } from '../ctx.ts';
import type { Checked, Exact, InputFields, InputOf, ValidInputs } from '../fields.ts';
import type {
	ChannelName, CollectionSpecOf, ColumnValue, Direction, ModelName, OneRels, PolicyName, ReadField, Row, WritableField
} from '../names.ts';
import type { Where } from '../where.ts';
import type { IanaZone, NonEmpty } from '../values.ts';
import type { Cron } from './automation.ts';
import type { Inbound } from './channel.ts';
import type { ConnectionName, TransportOf } from './names.ts';

/** `resolve` and `known` read as the integration's (or the caller's) system actor; no I/O. */
export type IntegrationCtx = Pick<QueryCtx, 'now' | 'today' | 'tz'> & Pick<CallerReads, 'read' | 'get'>;
/**
 * How a two-way integration settles a record changed on both sides: remote wins, local wins, or the latest change.
 */
export type ConflictRule = 'remote_wins' | 'local_wins' | 'latest';
type Path = { path: string };
/**
 * Where an integration's records come from: an inbound channel, or a connection's list (and item) endpoints with their shape.
 */
export type IntegrationSource =
	| { channel: string; inbound?: true }
	| { connection: string; list: { path: string; records?: string; cursor?: string; shape: InputFields };
		create?: Path; update?: Path; delete?: Path; pull: { cron: string; tz?: IanaZone } };

// Callbacks sit inside these literals, so they are typed by inference sites (the source `X`, the `resolve` result `R`,
// an import's input `I` and record `Rec`), never by a `Checked` wrapper, which would hide their contextual types.
/** The remote record: an inbound message of the source channel, or the connection's declared `shape`. */
export type Remote<X> = X extends { channel: infer N } ? Inbound<TransportOf<N>> : X extends { list: { shape: infer F } } ? InputOf<F> : never;
type SourceFor<X, D> = X extends { channel: unknown }
	? D extends 'two_way' ? 'error: a channel source is never writable; two_way needs a connection with create and update' : { channel: ChannelName; inbound?: true }
	: X extends { connection: unknown; list: { shape: infer F }; pull: { cron: infer K } } ? {
		connection: ConnectionName; list: { path: string; records?: string; cursor?: string; shape: ValidInputs<F> };
		delete?: Path; pull: { cron: Cron<K>; tz?: IanaZone };
	} & (D extends 'two_way' ? { create: Path; update: Path } : { create?: Path; update?: Path })
	: IntegrationSource;
/** A key of the remote record. */
export type RemoteKey<R> = keyof R & string;
/** A remote key whose value fits the local field as is; anything else is an `in` mapping. */
type KeyFor<R, V> = { [K in keyof R]: R[K] extends V ? K : never }[keyof R] & string;
type Synced<C> = WritableField<C>;
type TwoWay<D, T> = D extends 'two_way' ? T : 'error: two_way only';
export type IntegrationSpec<C, X, R, Remote, OR extends string, D = Direction<C>> = {
	/** Must match the direction the names index records (P14). */
	direction: D extends 'one_way' | 'two_way' ? D : `error: the names index records no integration for ${C & string}`;
	// `Exact` refuses unknown keys; the spec itself adds the keys two_way requires
	source: X & Checked<IntegrationSource, X, Exact<X, SourceFor<X, D>> & SourceFor<X, D>>;
	/** The local field holding the remote id (the upsert key of a pull). */
	identity: Exclude<Synced<C>, keyof OneRels<C>>;
	/** One read per batch, as the integration actor; its result reaches every `in`. */
	resolve?: (ctx: IntegrationCtx) => Promise<R>;
	fields: { [F in Synced<C>]?: KeyFor<Remote, ColumnValue<C, F>> | { in: (remote: Remote, x: { resolve: R }) => ColumnValue<C, F> } };
	/** Local field → remote key (or a mapping) for the fields this side pushes. */
	push?: TwoWay<D, { [F in Synced<C>]?: keyof Remote & string | { out: (row: Row<C>) => unknown } }>;
	/** Who may change a field; a field in both lists never converges. */
	owns?: { remote?: readonly OR[]; local?: readonly Exclude<Synced<C>, OR>[] } & TwoWay<D, unknown>;
	/** Default 'remote_wins'. */
	conflicts?: TwoWay<D, { default: ConflictRule; fields?: { [F in Synced<C>]?: ConflictRule } }>;
	/** The system actor's authority for `resolve` reads and writes to other collections. */
	policies: NonEmpty<PolicyName>;
};

/**
 * `src/data/collection/<c>/+integration.ts`: keeps collection `<c>` in step with an outside system: the `source` (a
 * channel or a connection's list endpoint), the mapping onto rows, the direction (pull, push or both), conflict rules and
 * the policies its system actor holds. Runs as `<c>.integration`.
 */
export function integration<const C extends ModelName, const X extends IntegrationSource, R = undefined, const OR extends Synced<C> = never>(name: C,
	spec: IntegrationSpec<C, X, R, Remote<X>, OR>): { readonly name: C; readonly spec: IntegrationSpec<C, X, R, Remote<X>, OR> } {
	return { name, spec };
}

/** A problem an import found with one sheet row (`row` null: the whole file or a stored row): `refuse` blocks the file, `warn` waits for acceptance. */
export type ImportFinding = { readonly row: number | null; readonly column: string; readonly message: string; readonly severity: 'warn' | 'refuse' };
/** One sheet cell's value as a template row holds it. */
type TemplateCell = string | number | boolean | null;
/** What `known`, `map`, `related` and `check` receive beside the record: the page's context, decoded against `context`. */
type Context<X> = { readonly context: InputOf<X> };
type ImportSpec<C, I, Rec, M, K, X> = {
	description: CollectionSpecOf<C> extends { create: unknown } ? string : `error: ${C & string} exposes no create, so nothing can be imported`;
	/**
	 * The feed's input: a JSON upload decodes against it as is. An xlsx upload fills the input's one list of objects: the
	 * header row names its fields (by name or `label`), each later row is an item, blank cells are left out, and a
	 * `row: { kind: 'number' }` field receives the sheet row number.
	 */
	input: I & Checked<InputFields, I, Exact<I, ValidInputs<I>>>;
	/**
	 * What the view the import runs from is looking at (an entity, a period): the page passes it as its toolbar's
	 * `context`, and it decodes against these fields like any input. It narrows and defaults; it never authorizes.
	 */
	context?: X & Checked<InputFields, X, Exact<X, ValidInputs<X>>>;
	/** The records of one feed, from its input (a parsed file, a pasted list). */
	records: (input: InputOf<I>) => readonly Rec[];
	/**
	 * One resolver per upload, read as the caller, before any row is mapped: what the records' keys name (employee
	 * numbers to employments, codes to ids, an entity's time zone). Its value reaches `map`, `related` and `check` as `known`.
	 */
	known?: (ctx: IntegrationCtx, records: readonly Rec[], x: Context<X>) => Promise<K>;
	/** `null` skips the record. */
	// `M` keeps the returned literal checkable: an inferred callback's return is otherwise never excess-checked
	map: (record: Rec, x: { known: K } & Context<X>) => (M & Exact<M, Insert<C>>) | null;
	/**
	 * Rows of other collections a record also writes (a day of time off for a leave code), each created as the caller
	 * in the import's one act: one refusal anywhere refuses the whole file.
	 */
	related?: { [R in ModelName]?: (record: Rec, x: { known: K } & Context<X>) => readonly Insert<R>[] };
	/**
	 * The import is a set over a scope: per distinct `by` values (and, with `range`, from that group's first to its last
	 * `range` value), every stored row in scope the import does not name by the collection's key is deleted, in the same
	 * act. The groups come from `of(record)` for every record, a blank one included (a day the sheet empties is in scope
	 * and so deleted); without `of`, from the mapped rows. The collection's guards judge the deletes: its transform (with
	 * `delete: { transform: true }`), its state locks and its grants; one refusal refuses the whole file.
	 */
	scope?: { by: NonEmpty<WritableField<C>>; range?: WritableField<C>;
		of?: (record: Rec, x: { known: K } & Context<X>) => { readonly [F in WritableField<C>]?: ColumnValue<C, F> } | null };
	/** Findings over the mapped rows (`rows[i]` is `map(records[i])`), read as the caller; any `refuse` blocks the file, a `warn` waits for acceptance. */
	check?: (ctx: IntegrationCtx, x: { input: InputOf<I>; records: readonly Rec[]; rows: readonly (M | null)[]; known: K } & Context<X>) => Promise<readonly ImportFinding[]>;
	/** The rows a downloaded template is prefilled with, by input field name, read as the caller. Default: the header row alone. */
	template?: (ctx: IntegrationCtx, x: Context<X>) => Promise<readonly { readonly [field: string]: TemplateCell }[]>;
} & (Keyed<C> extends true ? { onConflict: 'update' | 'keep' } : { onConflict?: 'update' | 'keep' });
export type PipelineSpec<C, I, Rec, M = Insert<C>, K = undefined, X = {}> = {
	import?: ImportSpec<C, I, Rec, M, K, X>;
	export?: { description: string; select: readonly ReadField<C>[]; where?: Where<C>; format: 'csv' | 'xlsx' | 'json' };
};

/**
 * `src/data/collection/<c>/+pipeline.ts`: file import and export of collection `<c>`: an `import` maps a sheet's or file's
 * records onto inserts that enter through the collection's write pipeline as the caller (a JSON or xlsx upload, a
 * downloadable xlsx template, an optional `scope` set with deletes, `check` findings); an `export` writes the selected
 * fields as CSV, XLSX or JSON. The view toolbar's ⚡ menu wires every feed by itself.
 */
export function pipeline<const C extends ModelName, const I extends InputFields = {}, Rec = never, M = Insert<C>, K = undefined, const X extends InputFields = {}>(name: C,
	spec: PipelineSpec<C, I, Rec, M, K, X>): { readonly name: C; readonly spec: PipelineSpec<C, I, Rec, M, K, X> } {
	return { name, spec };
}
