// `PageBolt` (D9): `$bolt` as pages see it, over the same names, rows and inputs as `ctx`. A read is `Read<A>`, an Effect
// that carries its wire form so `live` can register it server-side; `live` is a Stream; acts, starts, uploads, record
// capabilities and the session are Effects failing with the D3 tags; `fileUrl`, `t` and `actor` stay plain. Pages run
// them on the ui edge (`run`, `fork`, `live`, `attach` from `$bolt`).
import type { Effect, Stream } from 'effect';
import type { FileUrlOptions } from '@norbital-ai/std/kind';
import type { Actor } from '../decl/access/actor.ts';
import type { StartableName } from '../decl/access/policy.ts';
import type {
	ActInput,
	ActOutput,
	AggRow,
	Callable,
	Committed,
	DeclaredQuery,
	DeclaredRow,
	In,
	ListResult,
	MessageKey,
	Outcome,
	Page,
	Paged,
	PendingApproval,
	QueryCallable,
	QueryInput,
	QueryOutput,
	ReadResult,
	Revision,
	Select,
	SimilaritiesOfC,
	SimilarityName
} from '../decl/ctx.ts';
import type {
	ActConflict,
	ActRefused,
	ActUnknown,
	ProtocolFailed,
	ReadFailed,
	Refusal,
	TransportFailed
} from '../decl/errors.ts';
import type {
	CollectionName,
	FileField,
	Is,
	ReadableName,
	ReadField,
	StoredRow
} from '../decl/names.ts';
import type { StartInput } from '../decl/runtime/facilities.ts';
import type { FileRef, Id, Instant, RequestId } from '../decl/values.ts';
import type { OrderBy, Where } from '../decl/where.ts';
import type { RecordCapabilities, RecordParentContext } from '../protocol/record-contracts.ts';
import type { WireRead } from '../protocol/wire.ts';

/** Run once for an answer, or pass to `live` for current answers. */
export type Read<A> = Effect.Effect<A, ReadFailed | TransportFailed> & { readonly read: WireRead };
/** Current answers from a subscribed read; consuming the Stream owns the subscription, and read failures are `ReadFailed`. */
export type LiveRead<A> = Stream.Stream<A, ReadFailed>;
/** A caller-authorized write: committed output or a held approval proposal succeeds; refusal, conflict and uncertain settlement are typed failures. */
export type PageAct<O, N = string> = Effect.Effect<
	Committed<O, N> | PendingApproval<N>,
	ActRefused | ActConflict | ActUnknown
>;
/** An automation's eventual outcome, carrying its run id and automation name before the caller waits for settlement. */
export type PageStart<A extends string = string> = Effect.Effect<Outcome<unknown>> & {
	/** The first run's id; `ids` holds every run's, one per input. */
	readonly id: Id<'sys_run'>;
	readonly ids: readonly Id<'sys_run'>[];
	readonly automation: A;
};
/** A page operation with its own typed failure channel, executed by the mounted UI runtime through `run`, `fork` or `attach`. */
export type PageCall<A, E> = Effect.Effect<A, E>;

type UploadField = { [C in CollectionName]: `${C}.${FileField<C>}` }[CollectionName];
type Bucket<C> =
	| ReadField<C>
	| { [U in 'day' | 'week' | 'month' | 'quarter' | 'year']: { [P in U]: ReadField<C> } }[
			'day' | 'week' | 'month' | 'quarter' | 'year'];
type Measure<C> = readonly NoInfer<ReadField<C>>[];
type Measures<C> = {
	count?: true;
	sum?: Measure<C>;
	avg?: Measure<C>;
	min?: Measure<C>;
	max?: Measure<C>;
	where?: NoInfer<Where<C>>;
};

/** The typed members of `$bolt` (§3.5); a page reads and acts as its viewer, so rows are caller rows. */
export interface PageBolt {
	/** Dynamic declarations use the viewer's native read policies and retain any masked selected values. */
	read<C extends string>(
		collection: Is<C, ReadableName>,
		query: DeclaredQuery
	): Read<Page<DeclaredRow<C>>>;
	/** The record's field and operation permissions for its current revision; `null` when it is absent or not readable. */
	recordCapabilities<C extends string>(
		collection: Is<C, ReadableName>,
		id: NoInfer<Id<C>>,
		parent?: RecordParentContext
	): PageCall<RecordCapabilities | null, TransportFailed | ProtocolFailed>;
	/**
	 * A page of rows the caller may read: `where`, `select`, `orderBy`, a text `search`, and `limit` (or `all: true`).
	 * @example
	 * const open = live(() => bolt.live(bolt.read('jobs', { where: { status: { eq: 'open' } }, orderBy: { due_on: 'asc' }, limit: 50 })));
	 */
	read<C extends string, const S extends Select<C> = {}>(
		collection: Is<C, ReadableName>,
		q: {
			where?: NoInfer<Where<C>>;
			select?: S;
			orderBy?: NoInfer<OrderBy<C>>;
			search?: string;
		} & Paged
	): Read<Page<ListResult<C, S>>>;
	/** One record by id as the caller reads it, with an optional `select`; `null` when it is absent or not readable. */
	get<C extends string, const S extends Select<C> = {}>(
		collection: Is<C, ReadableName>,
		id: NoInfer<Id<C>>,
		select?: S
	): Read<ReadResult<C, S> | null>;
	/** The record as of `revision`, folded from its history (L-BOLT-181); `null` when its create was pruned or history is not readable. */
	get<C extends string>(
		collection: Is<C, ReadableName>,
		id: NoInfer<Id<C>>,
		select: undefined,
		options: { revision: number }
	): Read<StoredRow<C> | null>;
	/** Without `by`, one row over the whole scope; with `by`, a page of buckets (rule 9). */
	aggregate<C extends string>(
		collection: Is<C, ReadableName>,
		q: Measures<C> & { by?: never }
	): Read<AggRow>;
	aggregate<C extends string>(
		collection: Is<C, ReadableName>,
		q: Measures<C> & { by: NoInfer<Bucket<C>> | readonly NoInfer<Bucket<C>>[] } & Paged
	): Read<Page<AggRow>>;
	/** A named similarity search (§3.3.4): nearest first, each row with its `$distance`. */
	similar<C extends string, N extends SimilarityName<C>, const S extends Select<C> = {}>(
		collection: Is<C, ReadableName>,
		search: N,
		input: NoInfer<In<SimilaritiesOfC<C>[N]>>,
		q: { where?: NoInfer<Where<C>>; select?: S; limit: number }
	): Read<readonly (ListResult<C, S> & { readonly $distance: number })[]>;
	/** Over `search.semantic` (L-BOLT-123): nearest by meaning to a text, or to a record's own embedding (the record itself left out). */
	similar<C extends string, const S extends Select<C> = {}>(
		collection: Is<C, ReadableName>,
		q: {
			to: string | { record: { id: NoInfer<Id<C>> } };
			where?: NoInfer<Where<C>>;
			select?: S;
			limit: number;
		}
	): Read<readonly (ListResult<C, S> & { readonly $distance: number })[]>;
	/** A record's revisions, newest first, or as of an instant, a revision or before an approval request. */
	history<C extends string>(
		collection: Is<C, ReadableName>,
		id: NoInfer<Id<C>>,
		options?: { at?: { instant: Instant } | { revision: number } | { before: RequestId } }
	): Read<readonly Revision<C>[]>;
	/** Runs a collection query (`'<c>.<q>'`) with its typed input. */
	query<const N extends string>(
		name: Is<N, QueryCallable>,
		input: NoInfer<QueryInput<N>>
	): Read<QueryOutput<N>>;
	/** Keeps a read current: re-read when the rows it depends on change (or `on` those collections, or `every` interval). */
	live<A>(read: Read<A>, options?: { every?: string; on?: readonly CollectionName[] }): LiveRead<A>;
	/** Runs a callable with its typed input; a held write is a success. */
	act<const N extends string>(
		callable: Is<N, Callable>,
		input: NoInfer<ActInput<N>>,
		options?: { key?: string; once?: string; observed?: Readonly<Record<string, number>> }
	): PageAct<ActOutput<N>, N>;
	/**
	 * Starts an automation now with its typed input, or once per input in one request (a bulk action over selected
	 * records); `id`/`ids` are the runs' ids before the outcome settles (a toolbar item returning it shows the runs).
	 */
	start<const A extends string>(
		automation: Is<A, StartableName>,
		input: NoInfer<StartInput<A>> | readonly NoInfer<StartInput<A>>[]
	): PageStart<A>;
	/** `accept` and `max` are checked before bytes are stored; a refusal is `ActRefused`. */
	upload(
		file: Blob & { name?: string },
		field: UploadField
	): PageCall<FileRef, ActRefused | TransportFailed>;
	/** The URL a page shows or downloads a stored file from. */
	fileUrl(ref: FileRef, options?: FileUrlOptions): string;
	/** A message of `+messages.ts` in the page's locale, `{name}` placeholders filled from `vars`. */
	t(key: MessageKey, vars?: { readonly [name: string]: string | number }): string;
	/**
	 * On-page sign-in (§5.11.2): `sendCode` texts or emails a six-digit code, `verify` proves it, signs the viewer in — a
	 * newcomer joins where the workspace declares `signup` — and reloads the page as them. A refusal is a `Refusal`. ui's
	 * `<PhoneVerify session={bolt.session} />` is the whole control.
	 */
	session: {
		sendCode(address: string): PageCall<void, Refusal>;
		verify(address: string, code: string): PageCall<void, Refusal>;
	};
	/** Who the page runs as; `null` before a visitor page has one. */
	actor: Actor | null;
}
