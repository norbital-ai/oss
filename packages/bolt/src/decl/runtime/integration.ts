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

type ImportSpec<C, I, Rec, M> = {
	description: CollectionSpecOf<C> extends { create: unknown } ? string : `error: ${C & string} exposes no create, so nothing can be imported`;
	input: I & Checked<InputFields, I, Exact<I, ValidInputs<I>>>;
	/** The records of one feed, from its input (a parsed file, a pasted list). */
	records: (input: InputOf<I>) => readonly Rec[];
	known?: (ctx: IntegrationCtx, keys: readonly string[]) => Promise<readonly Row<C>[]>;
	/** `null` skips the record. */
	// `M` keeps the returned literal checkable: an inferred callback's return is otherwise never excess-checked
	map: (record: Rec, x: { known: ReadonlyMap<string, Row<C>> }) => (M & Exact<M, Insert<C>>) | null;
} & (Keyed<C> extends true ? { onConflict: 'update' | 'keep' } : { onConflict?: 'update' | 'keep' });
export type PipelineSpec<C, I, Rec, M = Insert<C>> = {
	import?: ImportSpec<C, I, Rec, M>;
	export?: { description: string; select: readonly ReadField<C>[]; where?: Where<C>; format: 'csv' | 'xlsx' | 'json' };
};

/**
 * `src/data/collection/<c>/+pipeline.ts`: file import and export of collection `<c>`: an `import` maps a sheet's or file's
 * records onto inserts that enter through the collection's write pipeline as the caller; an `export` writes the selected
 * fields as CSV, XLSX or JSON.
 */
export function pipeline<const C extends ModelName, const I extends InputFields = {}, Rec = never, M = Insert<C>>(name: C,
	spec: PipelineSpec<C, I, Rec, M>): { readonly name: C; readonly spec: PipelineSpec<C, I, Rec, M> } {
	return { name, spec };
}
