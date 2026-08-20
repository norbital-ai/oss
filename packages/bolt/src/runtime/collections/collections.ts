import { deriveRecordId } from '../derive-record-id.js';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { AccessControl } from '../access/access-control.js';
import { ApprovalConflict, Approvals } from '../approvals/approvals.js';
import { Database } from '../facilities/database.js';
import { SyncWake } from '../sync/wake.js';
import { AI, Files } from '../facilities/services.js';
import { TaskQueue } from '../tasks/tasks.js';
import { Automations } from '../automations/automations.js';
import { Identity, Subject } from '../identity/identity.js';
import { Workspace } from '../workspace.js';
import { searchableColumns } from '../../authoring/model-introspection.js';
import type { CollectionDefinition, FieldDefinition } from '../../authoring/workspace-schema.js';
import {
	eventRecord,
	outboxEntriesFor,
	sendSubscriptions,
	watchesOperation,
	type SendSubscription
} from '../integrations/outbox.js';
import {
	compileOrderTerms,
	compileWhere,
	makeWhereContext,
	renderOrderBy,
	WhereCompileError,
	type OrderTerm,
	type WhereContext
} from './where.js';
import { attachRelations } from './prefetch.js';
import {
	afterMillisOf,
	AuthoredRuntimeService,
	makeAuthoringApi,
	runAuthoredHandler,
	inferenceTurnContent,
	type AuthoredCollectionOps,
	type AuthoredCollectionHookModule
} from './authored.js';
import { AuthoredRefusal, refusalAt, type RefusalSite } from '../../authoring/refusal.js';
import { InvocationBudget } from '../budget.js';

export const Predicate = Schema.TaggedUnion({
	Equal: { field: Schema.NonEmptyString, value: Schema.Json },
	NotEqual: { field: Schema.NonEmptyString, value: Schema.Json },
	GreaterThan: { field: Schema.NonEmptyString, value: Schema.Json },
	In: { field: Schema.NonEmptyString, values: Schema.Array(Schema.Json) }
});
export type Predicate = typeof Predicate.Type;

export type CompiledQuery = Readonly<{
	readonly sql: string;
	readonly parameters: ReadonlyArray<Schema.Json>;
}>;
export type HistoryEntry = Readonly<{
	readonly collection: string;
	readonly recordId: string;
	readonly operation: 'create' | 'update' | 'delete';
	readonly version: number;
}>;
const JsonObject = Schema.Record(Schema.String, Schema.Json);

/**
 * How many related rows one prefetch may load.
 *
 * A page of parents fans out to at most this many children per relation. It is deliberately far
 * above a page size and still bounded — an unbounded prefetch would let one screen pull a whole
 * collection into memory.
 */
const PREFETCH_LIMIT = 5000;
const CollectionAction = Schema.Literals(['create', 'update', 'delete']);
const CollectionOperation = Schema.Struct({
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	values: Schema.Record(Schema.String, Schema.Json),
	action: CollectionAction,
	subject: Subject
});

/** Holds a collection mutation until every required approval step is complete. */
export class PendingApproval extends Schema.TaggedError<PendingApproval>()(
	'Bolt.Collections.PendingApproval',
	{
		requestId: Schema.NonEmptyString,
		collection: Schema.NonEmptyString,
		id: Schema.NonEmptyString,
		action: CollectionAction
	}
) {
	readonly category = 'pending-approval' as const;
	readonly retryable = false;
}

/** Which of a batch's three phases a failure came out of. */
export const MutationPhase = Schema.Literals(['prepare', 'commit', 'settle']);
export type MutationPhase = typeof MutationPhase.Type;

/**
 * Which phase of a batched write failed, wrapped around the failure that says why.
 *
 * The three phases mean three different things to whoever is handling the failure, and until this
 * existed they were indistinguishable — every one of them arrived as whatever error happened to be
 * raised, with no way to tell how much of the write had happened by then.
 *
 * - `prepare` — decode, `prepare`, and the `before` hooks, all outside the transaction. **Nothing
 *   was written.** A caller may retry the whole batch, or show the refusal and stop.
 * - `commit` — the one transaction. It is atomic, so **nothing was written** here either, and a
 *   caller may retry. This is separated from `prepare` because the causes are unalike: a `prepare`
 *   failure is almost always a business rule and a `commit` failure is almost always the database.
 * - `settle` — the read-back, the `after` hooks and the enqueue. **The write already happened.** A
 *   caller must not retry the batch: it would write it a second time. `committed` names the rows
 *   that are now facts so the caller can report or reconcile them.
 *
 * `cause` is kept rather than replaced, and this is the part that matters more than the tag. An
 * `AuthoredRefusal` mapped to a 422 and a `PendingApproval` answered as a 202 are decisions made
 * far downstream by `instanceof`, so a wrapper that swallowed the original would silently turn every
 * business rule in the workspace back into a 500 — the exact regression `AuthoredRefusal` was built
 * to end. `runtime/app.ts` unwraps this before its own mapping runs, so the phase is additive: it
 * adds a fact nobody had, and takes nothing away.
 */
export class MutationPhaseFailure extends Schema.TaggedError<MutationPhaseFailure>()(
	'Bolt.Collections.MutationPhaseFailure',
	{
		phase: MutationPhase,
		collection: Schema.NonEmptyString,
		/**
		 * The ids the transaction carried, and only on `settle`.
		 *
		 * Empty on `prepare` and `commit`, because on those nothing is a fact — an empty list there is
		 * the truth rather than a missing value. On `settle` it is every node of every graph the
		 * transaction carried, children included, in the order they were applied.
		 */
		committed: Schema.Array(Schema.NonEmptyString),
		cause: Schema.Unknown
	}
) {
	readonly retryable = false;
	/** The failure this wrapped, for a caller that would rather test than unwrap by hand. */
	get underlying(): unknown {
		return this.cause;
	}
}

/**
 * The failure a phase raised, or the phase failure it already is.
 *
 * A batch's phases are entered from `mutate`, which is itself reachable from a hook running inside
 * another batch's `prepare`. Wrapping a wrapper would report the inner batch's phase as the outer
 * one's, so the innermost — the one that actually knows what was written — wins.
 */
export const mutationPhaseFailure = (
	phase: MutationPhase,
	collection: string,
	committed: ReadonlyArray<string>,
	cause: unknown
): MutationPhaseFailure =>
	cause instanceof MutationPhaseFailure
		? cause
		: new MutationPhaseFailure({ phase, collection, committed, cause });

/**
 * The failure underneath a phase wrapper, or the value itself when it is not one.
 *
 * Used by anything that maps a failure by its type — the host boundary above all — so that adding
 * the phase did not require every one of those tests to learn about it.
 */
export const unwrapMutationPhase = (cause: unknown): unknown =>
	cause instanceof MutationPhaseFailure ? cause.cause : cause;

/** Owns identifier safety, predicate compilation, and parameter rebasing. */
const CollectionSql = {
	quoteIdentifier: (name: string): string => `"${name.replaceAll('"', '""')}"`,
	offsetParameters: (sql: string, offset: number): string =>
		sql.replaceAll(/\$(\d+)/g, (_token, index: string) => `$${Number(index) + offset}`),
	compilePredicate: (predicate: Predicate, offset = 0): CompiledQuery =>
		Predicate.match(predicate, {
			Equal: ({ field, value }) => ({
				sql: `${CollectionSql.quoteIdentifier(field)} = $${offset + 1}`,
				parameters: [value]
			}),
			NotEqual: ({ field, value }) => ({
				sql: `${CollectionSql.quoteIdentifier(field)} <> $${offset + 1}`,
				parameters: [value]
			}),
			GreaterThan: ({ field, value }) => ({
				sql: `${CollectionSql.quoteIdentifier(field)} > $${offset + 1}`,
				parameters: [value]
			}),
			In: ({ field, values }) => ({
				sql:
					values.length === 0
						? 'false'
						: `${CollectionSql.quoteIdentifier(field)} in (${values.map((_, index) => `$${offset + index + 1}`).join(', ')})`,
				parameters: values
			})
		})
};
export const quoteIdentifier = CollectionSql.quoteIdentifier;
export const compilePredicate = CollectionSql.compilePredicate;
const offsetParameters = CollectionSql.offsetParameters;

export type QueryInput = Readonly<{
	readonly collection: string;
	readonly predicate?: Predicate;
	// `where` and `orderBy` stay `unknown`: authored handlers bind `Date` operands the wire form
	// never carries, and the where compiler is the one place that decides what is bindable.
	readonly where?: unknown;
	readonly orderBy?: unknown;
	readonly limit?: number;
	/**
	 * Relations to load alongside the rows. Stays `unknown` for the same reason `where` does — the
	 * prefetch resolver owns what a relation spec may contain.
	 */
	readonly with?: unknown;
	/**
	 * Free text to match across the collection's searchable columns.
	 *
	 * Opt-in per column: a field must declare `search: true`. A collection that declares none is not
	 * searchable, and a search term against it matches nothing rather than quietly scanning
	 * everything — which is the difference between "no results" and "this box does nothing".
	 */
	readonly search?: string;
	/**
	 * Where the next page starts: the encoded ordering tuple of the previous page's last row.
	 *
	 * A seek, not an offset. Collections here are large, so an offset both degrades as the page index
	 * grows and drifts under concurrent writes — a row inserted before the offset shifts every later
	 * page by one, which shows up as a row seen twice and a row never seen at all.
	 */
	readonly after?: string;
}>;

export type MutationInput = Readonly<{
	readonly collection: string;
	readonly id: string;
	readonly values: Readonly<Record<string, Schema.Json>>;
}>;

/**
 * One nearest-neighbour read against a pgvector column.
 *
 * The operands stay `unknown` for the reason `QueryInput.where` does: they arrive from authored
 * code, and the one place that decides what a vector search may be given is the place that renders
 * the SQL for it. Everything here was previously spread into an ordinary `findMany`, which knows no
 * `column`, no `probe` and no `metric` — so the whole config was dropped on the floor and the caller
 * received the collection's first hundred rows as its "nearest" neighbours.
 */
export type NearestInput = Readonly<{
	readonly collection: string;
	readonly column: unknown;
	readonly probe: unknown;
	readonly metric: unknown;
	readonly limit: unknown;
	readonly maxDistance?: unknown;
	readonly excludeIds?: unknown;
}>;

/**
 * The pgvector distance operator each declared metric measures with.
 *
 * `<#>` is the *negative* inner product, which is what makes `order by` ascending mean "most
 * similar" for all three; a caller comparing `ip` distances against a threshold is comparing
 * negatives, and the authoring contract says so.
 */
const NEAREST_OPERATORS = { cosine: '<=>', l2: '<->', ip: '<#>' } as const;

/**
 * How many levels of hook-caused writes one originating write may set off.
 *
 * Separate from `InvocationBudget`'s limit even though the number matches, because they bound
 * different things: that one counts *enqueued* work, which the host runs later on its own
 * invocation, and this counts writes nested inside one invocation's own fiber tree. They share the
 * error type because they are the same message to whoever reads it — something recursed — and
 * nothing is served by two codes for it.
 */
const HOOK_NESTING_LIMIT = 8;

/**
 * `AuthoredRefusal` is a member of all three channels because authored code runs on all three
 * paths: hooks on every mutation, the import pipeline under `import`, the export pipeline under
 * `export`, and `create.after` again when an approval resumes. It is stated rather than left to
 * inference so that a caller which handles these unions exhaustively has to decide what a business
 * rule refusing means for it — which is the distinction the whole change exists to make available.
 */
type MutationError =
	| Workspace.WorkspaceLookupError
	| AccessControl.AccessDenied
	| Database.FacilityError
	| ApprovalConflict
	| PendingApproval
	| AuthoredRefusal
	| InvocationBudget.NestingLimitExceeded;
/**
 * What the *batched* path adds, and why it is not a member of `MutationError`.
 *
 * Only `mutate` runs in phases, so only `mutate` can say which one failed. Widening `MutationError`
 * would have put the phase on `create`, `update`, `delete`, `import` and `resume` as well, and on
 * every service that declares an error union containing theirs — `sync.mutate` and `agents.turn`
 * both do — none of which can ever raise it. That is a type that says something false about five
 * paths in order to say something true about one.
 */
type BatchMutationError = MutationError | MutationPhaseFailure;
type ResumeError =
	| Workspace.WorkspaceLookupError
	| AccessControl.AccessDenied
	| Database.FacilityError
	| ApprovalConflict
	| AuthoredRefusal
	| InvocationBudget.NestingLimitExceeded;
/** Query paths add the where-compiler failure so an unsupported filter surfaces instead of silently widening the result. */
type QueryError =
	| Workspace.WorkspaceLookupError
	| AccessControl.AccessDenied
	| Database.FacilityError
	| WhereCompileError
	| AuthoredRefusal
	| InvocationBudget.NestingLimitExceeded;

export type Interface = Readonly<{
	readonly findMany: (
		effectId: EffectId,
		subject: Identity.Subject,
		input: QueryInput
	) => Effect.Effect<ReadonlyArray<Schema.Json>, QueryError>;
	readonly findFirst: (
		effectId: EffectId,
		subject: Identity.Subject,
		input: QueryInput
	) => Effect.Effect<Schema.Json | undefined, QueryError>;
	readonly findNearest: (
		effectId: EffectId,
		subject: Identity.Subject,
		input: NearestInput
	) => Effect.Effect<ReadonlyArray<Schema.Json>, QueryError>;
	readonly count: (
		effectId: EffectId,
		subject: Identity.Subject,
		input: QueryInput
	) => Effect.Effect<number, QueryError>;
	readonly create: (
		effectId: EffectId,
		subject: Identity.Subject,
		input: MutationInput
	) => Effect.Effect<void, MutationError>;
	readonly createMany: (
		effectId: EffectId,
		subject: Identity.Subject,
		inputs: ReadonlyArray<MutationInput>
	) => Effect.Effect<void, MutationError>;
	/**
	 * The batched write, and the one every batch goes through.
	 *
	 * On the interface rather than only behind the authoring api because it is not an authoring
	 * convenience: it is the write path, and a command surface that wants a batch should reach the
	 * same one a hook does rather than loop a single create.
	 */
	readonly mutate: (
		effectId: EffectId,
		subject: Identity.Subject,
		collection: string,
		payloads: ReadonlyArray<Readonly<Record<string, unknown>>>,
		elevated?: boolean,
		depth?: number,
		options?: { readonly batchSize?: number }
	) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, BatchMutationError>;
	readonly update: (
		effectId: EffectId,
		subject: Identity.Subject,
		input: MutationInput
	) => Effect.Effect<void, MutationError>;
	readonly delete: (
		effectId: EffectId,
		subject: Identity.Subject,
		collection: string,
		id: string
	) => Effect.Effect<void, MutationError>;
	readonly resume: (effectId: EffectId, requestId: string) => Effect.Effect<void, ResumeError>;
	readonly discard: (effectId: EffectId, requestId: string) => Effect.Effect<void, ResumeError>;
	readonly import: (
		effectId: EffectId,
		subject: Identity.Subject,
		inputs: ReadonlyArray<MutationInput>
	) => Effect.Effect<number, MutationError>;
	readonly export: (
		effectId: EffectId,
		subject: Identity.Subject,
		input: QueryInput
	) => Effect.Effect<ReadonlyArray<Schema.Json>, QueryError>;
	readonly history: (
		effectId: EffectId,
		subject: Identity.Subject,
		collection: string,
		id: string
	) => Effect.Effect<ReadonlyArray<Schema.Json>, QueryError>;
}>;

/** Identifies the collections service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Collections');

/**
 * Drops values the database computes. A `generatedAlwaysAs` column rejects any write, so a caller
 * that echoes a whole row back — an import, a seed, an optimistic client mutation — would fail the
 * statement outright on a column it never chose to set.
 */
const writableValues = (
	values: Readonly<Record<string, Schema.Json>>,
	definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
): Readonly<Record<string, Schema.Json>> => {
	const generated = Object.entries(definition.fields)
		.filter(([, field]) => field.generated !== undefined)
		.map(([name]) => name);
	if (generated.length === 0) return values;
	return Object.fromEntries(Object.entries(values).filter(([name]) => !generated.includes(name)));
};

/**
 * Resolves one query's SQL predicate. A `where` object owns the answer when present; otherwise a
 * structured `predicate` does. Compilation failure is raised here so every read path reports the
 * offending column rather than running a widened query.
 */
const compiledFilter = (
	input: QueryInput,
	context: WhereContext
): Effect.Effect<CompiledQuery, WhereCompileError> => {
	if (input.where === undefined) {
		return Effect.succeed(
			input.predicate === undefined
				? { sql: 'true', parameters: [] }
				: compilePredicate(input.predicate)
		);
	}
	const compiled = compileWhere(input.where, context);
	return Result.isFailure(compiled)
		? Effect.fail(compiled.failure)
		: Effect.succeed(compiled.success);
};

/**
 * Matches free text against the columns a collection declared searchable.
 *
 * Case-insensitive containment across every opted-in column, which is what a person means by typing
 * into a search box. A collection with no searchable column yields `true` — the caller decides
 * whether to offer a search box at all, and a term that reached here anyway must not silently widen
 * into a full scan.
 */
const searchClause = (
	fields: Readonly<Record<string, FieldDefinition>>,
	term: string | undefined,
	offset: number
): CompiledQuery => {
	const trimmed = term?.trim() ?? '';
	// The same reader the trigram indexes are emitted from, so the columns searched and the columns
	// indexed cannot come apart.
	const searchable = searchableColumns(fields);
	if (trimmed === '') return { sql: 'true', parameters: [] };
	// A term against a collection that opted no column in matches nothing. Returning `true` here would
	// hand back every row, which is how a search box comes to look like it does nothing at all.
	if (searchable.length === 0) return { sql: 'false', parameters: [] };
	const clauses = searchable.map((name) => `${quoteIdentifier(name)}::text ilike $${offset + 1}`);
	return { sql: clauses.join(' or '), parameters: [`%${trimmed}%`] };
};

/** The scalar ordering values a cursor may carry — a json column has no total SQL order to seek along. */
type CursorValue = string | number | boolean | null;

/**
 * The keyset cursor: an opaque token carrying the ordering tuple a page ended on.
 *
 * It records the sort it was cut from as well as the values, so a token handed back under a
 * different sort is refused rather than seeking on columns it was never measured against. Every
 * rejection travels through `WhereCompileError`, the failure this read path already carries, because
 * silently ignoring a bad cursor returns page one — indistinguishable from paging not working.
 */
const CollectionCursor = {
	isValue: (value: unknown): value is CursorValue =>
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean',
	// `btoa` only accepts latin1, so the payload is widened to bytes first: an ordering tuple holding
	// an accented name would otherwise throw on encode.
	encodeText: (text: string): string =>
		btoa(String.fromCharCode(...new TextEncoder().encode(text)))
			.replaceAll('+', '-')
			.replaceAll('/', '_')
			.replaceAll('=', ''),
	decodeText: (token: string): string | undefined => {
		try {
			const binary = atob(token.replaceAll('-', '+').replaceAll('_', '/'));
			return new TextDecoder().decode(
				Uint8Array.from(binary, (character) => character.charCodeAt(0))
			);
		} catch {
			return undefined;
		}
	},
	encode: (terms: ReadonlyArray<OrderTerm>, row: Schema.Json): string | null => {
		if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
		const order: Array<OrderTerm & { readonly value: CursorValue }> = [];
		for (const term of terms) {
			const value: unknown = Reflect.get(row, term.column);
			// A field-masking policy can strip an ordering column out of the row it returns, and a json
			// column has no scalar to seek on. Neither has an honest cursor, and a guessed one seeks to
			// the wrong place — so the page reports no successor instead of a wrong one.
			if (!CollectionCursor.isValue(value)) return null;
			order.push({ ...term, value });
		}
		return CollectionCursor.encodeText(JSON.stringify({ v: 1, order }));
	},
	decode: (
		cursor: string,
		terms: ReadonlyArray<OrderTerm>,
		collection: string
	): Result.Result<ReadonlyArray<CursorValue>, WhereCompileError> => {
		const refuse = (
			message: string
		): Result.Result<ReadonlyArray<CursorValue>, WhereCompileError> =>
			Result.fail(new WhereCompileError({ collection, field: 'after', message }));
		const text = CollectionCursor.decodeText(cursor);
		if (text === undefined) return refuse('Pagination cursor is not a decodable token.');
		const payload: unknown = (() => {
			try {
				return JSON.parse(text) as unknown;
			} catch {
				return undefined;
			}
		})();
		if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
			return refuse('Pagination cursor does not carry a cursor payload.');
		}
		if (Reflect.get(payload, 'v') !== 1)
			return refuse('Pagination cursor was issued in a different cursor format.');
		const order: unknown = Reflect.get(payload, 'order');
		if (!Array.isArray(order) || order.length !== terms.length) {
			return refuse('Pagination cursor does not match the active sort.');
		}
		const values: Array<CursorValue> = [];
		for (let index = 0; index < terms.length; index += 1) {
			const term = terms[index];
			const entry: unknown = order[index];
			if (term === undefined || entry === null || typeof entry !== 'object') {
				return refuse('Pagination cursor does not match the active sort.');
			}
			const value: unknown = Reflect.get(entry, 'value');
			if (
				Reflect.get(entry, 'column') !== term.column ||
				Reflect.get(entry, 'direction') !== term.direction ||
				!CollectionCursor.isValue(value)
			) {
				return refuse('Pagination cursor does not match the active sort.');
			}
			values.push(value);
		}
		return Result.succeed(values);
	},
	/**
	 * Every row that sorts strictly after the cursor tuple, expanded lexicographically: strictly after
	 * on the first column, or equal there and strictly after on the second, and so on.
	 *
	 * Each column seeks in its own compiled direction — `desc` compares with `<` — and against
	 * Postgres' null ordering, which places nulls last under `asc` and first under `desc`. Comparing a
	 * null with `>` yields null rather than false, so the null cases are spelled out; without them a
	 * page boundary landing on a nullable column silently drops every row that follows.
	 */
	seek: (
		terms: ReadonlyArray<OrderTerm>,
		values: ReadonlyArray<CursorValue>,
		offset: number
	): CompiledQuery => {
		const parameters: Array<CursorValue> = [];
		const bind = (value: CursorValue): string => {
			parameters.push(value);
			return `$${offset + parameters.length}`;
		};
		const branches: Array<string> = [];
		for (let index = 0; index < terms.length; index += 1) {
			const term = terms[index];
			if (term === undefined) continue;
			const value = values[index] ?? null;
			// Nothing sorts after a null under `asc`: the non-nulls came first, and the nulls that remain
			// are ties the later branches settle on the tiebreaker columns.
			if (term.direction === 'asc' && value === null) continue;
			const clauses: Array<string> = [];
			for (let prior = 0; prior < index; prior += 1) {
				const priorTerm = terms[prior];
				if (priorTerm === undefined) continue;
				const priorValue = values[prior] ?? null;
				const priorColumn = quoteIdentifier(priorTerm.column);
				clauses.push(
					priorValue === null ? `${priorColumn} is null` : `${priorColumn} = ${bind(priorValue)}`
				);
			}
			const column = quoteIdentifier(term.column);
			clauses.push(
				term.direction === 'asc'
					? `(${column} > ${bind(value)} or ${column} is null)`
					: value === null
						? `${column} is not null`
						: `${column} < ${bind(value)}`
			);
			branches.push(`(${clauses.join(' and ')})`);
		}
		return { sql: branches.length === 0 ? 'false' : branches.join(' or '), parameters };
	}
};

/** Encodes the cursor a client sends back as `after`. Exported for the command boundary that cuts pages. */
export const encodeCollectionCursor = CollectionCursor.encode;

/**
 * Resolves one page's seek predicate.
 *
 * No cursor means the first page, which is `true` rather than a quietly widened query. An unusable
 * cursor fails the read instead of being dropped — a dropped cursor returns page one, which looks
 * exactly like pagination never having worked.
 */
const seekFilter = (
	after: string | undefined,
	terms: ReadonlyArray<OrderTerm>,
	collection: string,
	offset: number
): Effect.Effect<CompiledQuery, WhereCompileError> => {
	if (after === undefined) return Effect.succeed({ sql: 'true', parameters: [] });
	const values = CollectionCursor.decode(after, terms, collection);
	return Result.isFailure(values)
		? Effect.fail(values.failure)
		: Effect.succeed(CollectionCursor.seek(terms, values.success, offset));
};

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const workspace = yield* Workspace.Service;
		const access = yield* AccessControl.Service;
		const database = yield* Database.Service;
		const approvals = yield* Approvals.Service;
		const ai = yield* AI.Service;
		const files = yield* Files.Service;
		const queue = yield* TaskQueue.Service;
		const automations = yield* Automations.Service;
		const authored = yield* AuthoredRuntimeService;
		// Announced from here rather than from the command boundary, because this is the only place
		// every write actually passes through: a command, an agent tool, an import, an automation and a
		// replica's own `sync.mutate` all land on these three functions. Announcing at `dispatch` would
		// have missed every write that did not arrive as a command.
		const wake = yield* SyncWake.Service;
		/**
		 * Every outbound integration binding, indexed by the collection whose writes it watches.
		 *
		 * Computed once here rather than per mutation. Almost no collection has one, so the cost of
		 * outbound delivery on a workspace that declares none is a single failed map lookup per write.
		 */
		const sendsByCollection = sendSubscriptions(
			workspace.definition.integrations,
			authored.integrations
		);
		const subscriptionsFor = (collection: string): ReadonlyArray<SendSubscription> =>
			sendsByCollection.get(collection) ?? [];
		/**
		 * The statements that queue this write's outbound deliveries, to be run in the write's own
		 * transaction.
		 *
		 * In the transaction and not after it, deliberately. A post-commit enqueue has a window where
		 * the row exists and the intent to tell anybody about it does not, and a process that dies in
		 * that window drops the event with nothing anywhere to show for it. Committing the row and the
		 * queue entry together is what makes "the outbox is the truth" a fact rather than a hope.
		 *
		 * An entry carrying a refusal — an authored trigger or body that threw — is queued straight to
		 * `failed`. That is the visible middle ground between failing a tenant's write over a mistyped
		 * predicate and silently dropping the event: the write lands, and the reason is a row an
		 * operator can find.
		 */
		const outboxStatements = (
			effectId: EffectId,
			subject: Identity.Subject,
			collection: string,
			id: string,
			operation: 'create' | 'update' | 'delete',
			values: Readonly<Record<string, Schema.Json>>,
			previous: Readonly<Record<string, unknown>> | undefined
		): ReadonlyArray<{ readonly sql: string; readonly parameters: ReadonlyArray<Schema.Json> }> => {
			const subscriptions = subscriptionsFor(collection);
			if (subscriptions.length === 0 || !watchesOperation(subscriptions, operation)) return [];
			const entries = outboxEntriesFor(subscriptions, subject, {
				operation,
				recordId: id,
				record: eventRecord(operation, id, values, previous),
				...(previous === undefined ? {} : { previous })
			});
			const deliveries = entries.map((entry) => ({
				sql: 'insert into bolt_integration_outbox (integration_name, binding_name, collection_name, record_id, operation, path, payload, status, last_error) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
				parameters: [
					entry.integration,
					entry.binding,
					entry.collection,
					entry.recordId,
					entry.operation,
					entry.path,
					entry.payload,
					entry.refusal === null ? 'pending' : 'failed',
					entry.refusal
				] as ReadonlyArray<Schema.Json>
			}));
			/**
			 * And the job that drains them, in this same transaction.
			 *
			 * This is what replaced a fixed `* * * * *` drain per sending integration — 1440 wakes a day
			 * against every sending tenant's database whether or not anything was ever queued, which was
			 * the single largest standing cost in the runtime. The delivery is now told about by the write
			 * that caused it: the row and the job commit together, so the job cannot exist without the
			 * delivery and the delivery cannot exist without the record change, and there is no window
			 * where one is true and the other is not.
			 *
			 * One task per *integration*, not per delivery and not per record. Per integration is what the
			 * drain already claims at — `distinct on (collection_name, record_id)` gives per-record
			 * ordering inside one drain — and it keeps the property the minute cron had for the right
			 * reason: a partner that is down backs off its own queue and nobody else's.
			 */
			const drains = [...new Set(entries.map((entry) => entry.integration))]
				.toSorted()
				.map((integration) => ({ integration, taskId: `${effectId}:flush:${integration}` }))
				.flatMap(({ integration, taskId }) =>
					queue.statements([
						{ command: 'integrations.flush', input: { name: integration }, effectId: taskId }
					])
				)
				.map((statement) => ({
					sql: statement.sql,
					parameters: statement.parameters as ReadonlyArray<Schema.Json>
				}));
			return [...deliveries, ...drains];
		};

		/**
		 * Tells the host to come back now, because this write is about to queue a delivery.
		 *
		 * Sent *before* the commit, never after. A crash between the message and the commit costs a
		 * false alarm — the host wakes, finds nothing due, re-arms — while a crash the other way round
		 * costs a committed delivery nobody ever comes back for. That asymmetry is the whole reason the
		 * order is fixed rather than convenient.
		 */
		const announceFlush = Effect.fn('Collections.announceFlush')(function* (
			effectId: EffectId,
			collection: string,
			operation: 'create' | 'update' | 'delete'
		) {
			const subscriptions = subscriptionsFor(collection);
			if (subscriptions.length === 0 || !watchesOperation(subscriptions, operation)) return;
			yield* queue.wake(EffectId.make(`${effectId}:wake`), Date.now());
		});
		/** Whether this collection has an outbound binding that needs the row as it was before the write. */
		const needsPreviousRow = (collection: string, operation: 'update' | 'delete'): boolean =>
			watchesOperation(subscriptionsFor(collection), operation);
		// Annotated from the interface because the body calls itself to prefetch relations, and a
		// self-referencing const cannot have its type inferred.
		/** Reads one row back without row-level visibility or masking — the elevated view hooks and change events see. */
		const readRowElevated = Effect.fn('Collections.readRowElevated')(function* (
			effectId: EffectId,
			collection: string,
			id: string
		) {
			const result = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `select * from ${quoteIdentifier(collection)} where norbital_id = $1`,
				parameters: [id]
			});
			const row = result.rows[0];
			return typeof row === 'object' && row !== null
				? (row as Readonly<Record<string, unknown>>)
				: undefined;
		});
		/**
		 * The bytes and description behind a `file()` column's value.
		 *
		 * A `file()` column holds the `norbital_id` of a `document_asset` row, and that row is the only
		 * thing that names the object-store key the bytes were written under, along with the file name,
		 * size and mime type nothing else records. Asking the Files facility for the *asset id* — which
		 * is what this used to do — asks for a key no upload ever wrote, so every authored
		 * `readFileAsset` resolved against nothing and `mimeType` was hardcoded `null` because there
		 * was no row being read to get one from.
		 *
		 * Read elevated, like every other read a hook's own follow-ups make: the caller already passed
		 * authorization for the record carrying the column, and `document_asset` is granted to any
		 * authenticated subject by the system read policy anyway.
		 */
		const readAsset = Effect.fn('Collections.readAsset')(function* (
			effectId: EffectId,
			assetId: string
		) {
			const row = yield* readRowElevated(effectId, 'document_asset', assetId);
			const storageKey = typeof row?.['storage_key'] === 'string' ? row['storage_key'] : undefined;
			if (row === undefined || storageKey === undefined) {
				return yield* new Database.FacilityError({
					operation: 'files.read',
					code: 'files.asset_missing',
					message: `No document_asset ${assetId}, so there is no stored object to read.`,
					retryable: false,
					outcome: 'known'
				});
			}
			const response = yield* files.execute(effectId, { _tag: 'Read', key: storageKey });
			const bytes = response.bytes ?? new Uint8Array();
			const mimeType = typeof row['mime_type'] === 'string' ? row['mime_type'] : null;
			const name = typeof row['file_name'] === 'string' ? row['file_name'] : assetId;
			return { id: assetId, name, mimeType, size: bytes.byteLength, bytes };
		});
		/**
		 * Runs one authored hook handler with its context object, resolving Effect, promise, and plain
		 * results alike, and stamping a refusal it raised with where it was raised.
		 *
		 * The handler is passed as a thunk rather than called here. It used to be invoked in the
		 * argument position — `runAuthoredHandler(hook.handler(context, api))` — and a plain
		 * synchronous handler is the common case, so `refuse` threw *before* `runAuthoredHandler` was
		 * entered and nothing it did could see the throw. That is the specific reason a business rule
		 * arrived at the host as an `ExecutionFailure`.
		 *
		 * `site` names the collection and the phase, because a refusal cannot: `refuse` takes a
		 * sentence and nothing else, and the author writing it is inside one hook and has no reason to
		 * repeat which one. `action` carries the qualified phase — `create.before`, `delete.after` —
		 * rather than the bare action, because the two halves mean different things to whoever reads
		 * the failure. A `before` refusal means nothing was written; an `after` refusal means the write
		 * already happened and is being reported, not undone.
		 */
		const runHook = <A = unknown>(
			hook: { readonly handler: (context: unknown, api: unknown) => unknown } | undefined,
			context: unknown,
			api: unknown,
			site: RefusalSite
		): Effect.Effect<A, AuthoredRefusal> => {
			if (hook === undefined) return Effect.succeed(undefined as A);
			return runAuthoredHandler<A>(() => hook.handler(context, api) as A).pipe(
				Effect.catch((refusal) => Effect.fail(refusalAt(refusal, site)))
			);
		};
		/**
		 * Refuses a hook chain that has stopped going anywhere.
		 *
		 * Hooks nest by design — a write runs hooks, and a hook may write, which runs more hooks — and
		 * that is how `employments` creates `employment_terms`. The shape has no natural floor: a hook
		 * that writes back to its own collection recurses until something stops it, and until this
		 * existed the only thing that did was the invocation deadline, by which point the chain had
		 * committed every write it managed to fit inside it. There is no transaction to roll those
		 * back, so "eventually times out" is not a bound worth having.
		 *
		 * Checked on the way *in* to a write, so the refusal names the collection whose hook went too
		 * deep. The limit is deliberately far above the real chains, which are two or three levels: it
		 * is here to catch a loop, not to shape a design.
		 */
		const refuseRunawayHooks = (
			action: string,
			collection: string,
			depth: number
		): Effect.Effect<void, InvocationBudget.NestingLimitExceeded> =>
			depth > HOOK_NESTING_LIMIT
				? Effect.fail(
						InvocationBudget.NestingLimitExceeded.at(
							`${action} on ${collection}, from a hook`,
							depth,
							HOOK_NESTING_LIMIT
						)
					)
				: Effect.void;
		/**
		 * Builds the invocation-bound authoring api from this layer's internals.
		 *
		 * The elevated form backs the after-hook `db.mutate`/`db.delete` surface: those write through
		 * the same statement paths but with no row-visibility predicate, which is the point of an
		 * after hook — the record already passed authorization, so its own follow-ups must not fail
		 * on a row filter the writer itself could not see past.
		 */
		const buildOps = (
			effectId: EffectId,
			subject: Identity.Subject,
			elevated = false,
			/**
			 * How many hooks deep the write that produced this api already is.
			 *
			 * A hook that writes runs the hooks of what it wrote, and those may write again. That is a
			 * legitimate and common shape — an employment's `create.after` creates its terms — but it is
			 * also a loop the moment a hook writes back to its own collection, and nothing else bounds
			 * it. The invocation deadline eventually would, by which time the chain has done however
			 * many writes it could fit into thirty seconds and every one of them is a fact.
			 */
			depth = 0
		): AuthoredCollectionOps => ({
			findMany: (collection, input) =>
				findMany(effectId, subject, { collection, ...input }).pipe(
					Effect.map((rows) => rows as ReadonlyArray<Readonly<Record<string, unknown>>>)
				),
			findFirst: (collection, input) =>
				findMany(effectId, subject, { collection, ...input, limit: 1 }).pipe(
					Effect.map((rows) => rows[0] as Readonly<Record<string, unknown>> | undefined)
				),
			count: (collection, input) =>
				findMany(effectId, subject, { collection, ...input }).pipe(
					Effect.map((rows) => rows.length)
				),
			findNearest: (collection, input) =>
				findNearest(effectId, subject, { collection, ...input } as NearestInput).pipe(
					Effect.map((rows) => rows as ReadonlyArray<Readonly<Record<string, unknown>>>)
				),
			runAutomation: (name, input, options) =>
				Effect.gen(function* () {
					const after = options?.after;
					const taskId = yield* automations.start(effectId, subject, name, input, {
						// The same duration vocabulary as everything else here — `'1 hour'`, `'30 seconds'`,
						// or milliseconds — rather than a second one invented for this field.
						...(after === undefined ? {} : { afterMillis: afterMillisOf(after) })
					});
					return { taskId };
				}),
			create: (collection, id, values) =>
				Effect.gen(function* () {
					yield* create(effectId, subject, { collection, id, values }, depth);
					const row = yield* readRowElevated(effectId, collection, id);
					return row ?? ({ norbital_id: id, ...values } as Readonly<Record<string, unknown>>);
				}),
			update: (collection, id, values) =>
				Effect.gen(function* () {
					yield* update(effectId, subject, { collection, id, values }, depth);
					const row = yield* readRowElevated(effectId, collection, id);
					return row ?? ({ norbital_id: id, ...values } as Readonly<Record<string, unknown>>);
				}),
			delete: (collection, id) => deleteRecord(effectId, subject, collection, id, depth),
			mutate: (collection, payloads, options) =>
				mutate(effectId, subject, collection, payloads, elevated, depth, options),
			approvalFindMany: (input) =>
				findMany(effectId, subject, { collection: 'approval_request', ...input }).pipe(
					Effect.map((rows) => rows as ReadonlyArray<Readonly<Record<string, unknown>>>)
				),
			approvalFindFirst: (input) =>
				findMany(effectId, subject, { collection: 'approval_request', ...input, limit: 1 }).pipe(
					Effect.map((rows) => rows[0] as Readonly<Record<string, unknown>> | undefined)
				),
			infer: (input) =>
				Effect.gen(function* () {
					const content = yield* inferenceTurnContent(input.prompt, input.images, (assetId) =>
						readAsset(effectId, assetId)
					);
					const response = yield* ai.execute(effectId, {
						_tag: 'Turn',
						model: input.model ?? 'gpt-5',
						messages: [{ role: 'user', content }],
						tools: [],
						maxOutputTokens: 4_096
					});
					return Schema.decodeUnknownSync(input.schema)(response.output);
				}),
			readFileAsset: (assetId) => readAsset(effectId, assetId)
		});
		const buildApi = (
			effectId: EffectId,
			subject: Identity.Subject,
			elevated = false,
			depth = 0
		): unknown => makeAuthoringApi(buildOps(effectId, subject, elevated, depth), { elevated });
		/**
		 * Enqueues the change-triggered automations a write just satisfied.
		 *
		 * A scheduled automation runs when a host wakes it; a change automation exists because a
		 * record did, so the write itself is the trigger — the row is read back elevated and handed
		 * to the task as `incoming_record`, the shape the authoring context types declare.
		 */
		const emitChangeEvents = Effect.fn('Collections.emitChangeEvents')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			collection: string,
			id: string,
			event: 'created' | 'updated' | 'deleted'
		) {
			const triggers = Object.values(authored.automations).filter(
				(automation) =>
					automation.trigger._tag === 'Change' &&
					automation.trigger.collection === collection &&
					automation.trigger.event === event
			);
			if (triggers.length === 0) return;
			const row =
				event === 'deleted' ? undefined : yield* readRowElevated(effectId, collection, id);
			for (const automation of triggers) {
				const taskId = `${effectId}:event:${automation.name}`;
				// Ignored rather than propagated, as it always was: a change trigger must not fail the
				// write that caused it. What changes is what an ignored failure now costs — the enqueue is
				// a row, so an automation that throws when it runs backs off and retries instead of
				// vanishing, and one that exhausts its attempts is a `failed` row somebody can find.
				yield* queue
					.enqueue(EffectId.make(taskId), [
						{
							command: `automations.${automation.name}`,
							input: {
								args: {},
								scope:
									event === 'deleted' || row === undefined
										? {}
										: { incoming_record: row as Schema.Json },
								bolt_run_as: subject
							},
							effectId: taskId
						}
					])
					.pipe(Effect.ignore);
			}
		});
		/**
		 * The same enqueues, for a whole batch, in one facility call.
		 *
		 * `emitChangeEvents` is per record and costs two round trips out of the isolate when a trigger
		 * is declared — a read to build `incoming_record`, then an enqueue — and a batch ran it in a
		 * sequential loop. On 89 payslips that is 178 round trips *after* the write had already
		 * committed in one; on a 4 000-row import it is 8 000. It never showed up because the function
		 * returns immediately when no automation watches the collection, so the cost appears the day a
		 * workspace declares its first change trigger and looks like the trigger being slow.
		 *
		 * Both halves collapse. The rows were already read back for the caller, so they are passed in
		 * rather than re-read, and `queue.enqueue` has always taken an array. Every task keeps the
		 * effect id it had — `<batch>:mutate:<index>:event:<name>` — so an enqueue that already
		 * happened is still recognised as the same one on a replay.
		 */
		const emitChangeEventsMany = Effect.fn('Collections.emitChangeEventsMany')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			collection: string,
			/**
			 * One entry per record that exists. A row that was never written is not passed in at all —
			 * a change event announces a record, and there is no record — so `row` is not optional:
			 * the caller has to have decided before it gets here.
			 */
			records: ReadonlyArray<{
				readonly taskScope: string;
				readonly row: Readonly<Record<string, unknown>>;
			}>,
			event: 'created' | 'updated' | 'deleted'
		) {
			if (records.length === 0) return;
			const triggers = Object.values(authored.automations).filter(
				(automation) =>
					automation.trigger._tag === 'Change' &&
					automation.trigger.collection === collection &&
					automation.trigger.event === event
			);
			if (triggers.length === 0) return;
			const enqueues = triggers.flatMap((automation) =>
				records.map((record) => {
					const taskId = `${record.taskScope}:event:${automation.name}`;
					const scope: Schema.Json =
						event === 'deleted' ? {} : { incoming_record: record.row as Schema.Json };
					return {
						command: `automations.${automation.name}`,
						input: { args: {}, scope, bolt_run_as: subject } as Schema.Json,
						effectId: taskId
					};
				})
			);
			// Ignored rather than propagated, as the per-row form always did: a change trigger must not
			// fail the write that caused it.
			yield* queue.enqueue(effectId, enqueues).pipe(Effect.ignore);
		});
		/**
		 * Decodes one payload through the collection's declared input, if it has one.
		 *
		 * Lifted out of `runCreateHooks` because `load` sees the batch's inputs and must see them in
		 * the same shape the handler will: a collection that declares two fields where the table has
		 * twenty would otherwise hand its batch read the raw payload and its handler the decoded one.
		 */
		const decodeCreateInput = Effect.fn('Collections.decodeCreateInput')(function* (
			collection: string,
			values: Readonly<Record<string, Schema.Json>>,
			module: AuthoredCollectionHookModule | undefined
		) {
			if (module?.create?.input === undefined) return values;
			const decoded = yield* Schema.decodeUnknownEffect(module.create.input)(values).pipe(
				Effect.mapError(
					() =>
						new AccessControl.AccessDenied({
							action: 'create',
							resource: collection,
							reason: 'hook input validation failed'
						})
				)
			);
			return decoded as Readonly<Record<string, Schema.Json>>;
		});
		/**
		 * The reads a batch needs, done once, handed to every record's hook in it.
		 *
		 * A hook is authored for one record, and one that reads is an N+1 by construction — the
		 * attendance rules ask two questions per row, so a four-thousand-row import asks eight
		 * thousand times. `load` is where the query a person would actually write goes: one read over
		 * the window the batch spans, instead of two per day.
		 *
		 * It is not a second place to write the rule. That was `batchHandler`, which was declared,
		 * never called, and had already drifted — one collection carried the same assertion in both of
		 * its hooks. `load` cannot drift from `handler` because it does not restate anything: it
		 * returns data, and the handler is still the only thing that decides.
		 *
		 * Undeclared, this is `undefined` and costs nothing.
		 */
		const runCreatePrepare = Effect.fn('Collections.runCreatePrepare')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			collection: string,
			inputs: ReadonlyArray<Readonly<Record<string, Schema.Json>>>,
			module: AuthoredCollectionHookModule | undefined,
			depth: number
		) {
			const prepare = module?.create?.prepare;
			if (prepare === undefined) return undefined;
			const api = buildApi(effectId, subject, false, depth + 1);
			return yield* runAuthoredHandler(() => prepare({ inputs, api }, api)).pipe(
				Effect.mapError((cause) => refusalAt(cause, { collection, action: 'create.prepare' }))
			);
		});
		const runCreateHooks = Effect.fn('Collections.runCreateHooks')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			input: MutationInput,
			module: AuthoredCollectionHookModule | undefined,
			depth = 0,
			prepared: unknown = undefined
		) {
			const api = buildApi(effectId, subject, false, depth + 1);
			// Already decoded by the caller. `load` sees the batch's inputs and the handler sees one of
			// them, and they must be the same shape — a collection declaring two fields where the table
			// has twenty would otherwise hand its batch read the raw payload and its handler the
			// decoded one.
			const values = input.values;
			const before = yield* runHook<unknown>(
				module?.create?.perRecord?.before,
				{ input: values, prepared, api },
				api,
				{
					collection: input.collection,
					action: 'create.before'
				}
			);
			return before !== null && before !== undefined && typeof before === 'object'
				? (before as Readonly<Record<string, Schema.Json>>)
				: values;
		});
		const findMany: Interface['findMany'] = Effect.fn('Collections.findMany')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			input: QueryInput
		) {
			const definition = yield* workspace.collection(input.collection);
			yield* access.authorize(subject, 'read', input.collection);
			const context = makeWhereContext(input.collection, definition.fields, workspace.definition);
			const compiled = yield* compiledFilter(input, context);
			const searched = searchClause(definition.fields, input.search, compiled.parameters.length);
			const visibility = access.predicate(subject, 'read', input.collection);
			const limit = Math.max(1, input.limit ?? 100);
			const ordering = compileOrderTerms(input.orderBy, context);
			// Seek parameters bind last, after the visibility predicate, so the offsets the filter,
			// search and visibility clauses already computed among themselves stay as they were. The
			// seek is one more conjunct, so a cursor pages the set the filter and search left.
			const seek = yield* seekFilter(
				input.after,
				ordering,
				input.collection,
				compiled.parameters.length + searched.parameters.length + visibility.parameters.length
			);
			const result = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `select * from ${quoteIdentifier(input.collection)} where (${compiled.sql}) and (${searched.sql}) and (${offsetParameters(visibility.sql, compiled.parameters.length + searched.parameters.length)}) and (${seek.sql})${renderOrderBy(ordering)} limit ${limit}`,
				parameters: [
					...compiled.parameters,
					...searched.parameters,
					...visibility.parameters,
					...seek.parameters
				]
			});
			const rows = result.rows.map((row) =>
				Schema.is(JsonObject)(row) ? access.mask(subject, 'read', input.collection, row) : row
			);
			// Related records are read through `findMany` itself, so each one passes the same
			// authorization, row visibility and masking as a direct query would. `with` cannot
			// become a way to read what the subject is not allowed to see.
			return yield* attachRelations(
				workspace.definition,
				input.collection,
				rows,
				input.with,
				(collection, column, values) =>
					findMany(effectId, subject, {
						collection,
						where: { [column]: { in: values } },
						limit: PREFETCH_LIMIT
					}).pipe(Effect.orElseSucceed(() => []))
			);
		});
		/**
		 * Nearest neighbours, measured in the database by the index that was declared for them.
		 *
		 * The distance operator is applied to the column itself rather than to an expression over it,
		 * because that is the only form pgvector's HNSW index can answer: `order by "col" <-> $1` uses
		 * the index, and any wrapping of `"col"` degrades it into a sequential scan over every row.
		 * The same expression is projected as `distance`, so a caller comparing against a threshold and
		 * the planner choosing an access path are reading one number.
		 *
		 * Row visibility is the read predicate every other read goes through, and `access.mask` runs on
		 * the record before `distance` is put back on it — a field-restricted policy must not be
		 * undone by a search, and `distance` is not a column of the collection for it to strip.
		 */
		const findNearest: Interface['findNearest'] = Effect.fn('Collections.findNearest')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			input: NearestInput
		) {
			const definition = yield* workspace.collection(input.collection);
			yield* access.authorize(subject, 'read', input.collection);
			const refuse = (field: string, message: string) =>
				new WhereCompileError({ collection: input.collection, field, message });
			const column = input.column;
			if (typeof column !== 'string' || !Object.hasOwn(definition.fields, column)) {
				return yield* refuse(
					typeof column === 'string' ? column : 'column',
					`'${String(column)}' is not a column of ${input.collection}; findNearest needs the vector column to measure against.`
				);
			}
			const metric = input.metric;
			if (typeof metric !== 'string' || !Object.hasOwn(NEAREST_OPERATORS, metric)) {
				return yield* refuse(
					'metric',
					`No distance metric '${String(metric)}'. Accepted metrics: ${Object.keys(NEAREST_OPERATORS).join(', ')}.`
				);
			}
			const probe = input.probe;
			if (
				!Array.isArray(probe) ||
				probe.length === 0 ||
				!probe.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
			) {
				return yield* refuse(
					'probe',
					"probe must be a non-empty array of finite numbers with the column's dimension."
				);
			}
			const excludeIds = input.excludeIds ?? [];
			if (!Array.isArray(excludeIds) || !excludeIds.every((entry) => typeof entry === 'string')) {
				return yield* refuse('excludeIds', 'excludeIds must be an array of record identifiers.');
			}
			if (
				input.maxDistance !== undefined &&
				(typeof input.maxDistance !== 'number' || !Number.isFinite(input.maxDistance))
			) {
				return yield* refuse('maxDistance', 'maxDistance must be a finite number.');
			}
			const limit = Math.max(
				1,
				Math.min(
					typeof input.limit === 'number' && Number.isFinite(input.limit)
						? Math.trunc(input.limit)
						: 100,
					500
				)
			);
			const parameters: Array<Schema.Json> = [];
			// A driver binds a JavaScript array to a Postgres *array*, and `vector` is not one. The
			// literal text form cast to `::vector` is what pgvector parses.
			const probeIndex = parameters.push(JSON.stringify(probe));
			const distanceSql = `(${quoteIdentifier(column)} ${NEAREST_OPERATORS[metric as keyof typeof NEAREST_OPERATORS]} $${probeIndex}::vector)`;
			const visibility = access.predicate(subject, 'read', input.collection);
			const visibilitySql = offsetParameters(visibility.sql, parameters.length);
			parameters.push(...visibility.parameters);
			const exclusionSql =
				excludeIds.length === 0
					? 'true'
					: `${quoteIdentifier('norbital_id')} not in (${excludeIds.map((identifier) => `$${parameters.push(identifier)}::uuid`).join(', ')})`;
			const boundSql =
				input.maxDistance === undefined
					? 'true'
					: `${distanceSql} <= $${parameters.push(input.maxDistance)}`;
			const result = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `select *, ${distanceSql} as distance from ${quoteIdentifier(input.collection)} where ${quoteIdentifier(column)} is not null and (${visibilitySql}) and (${exclusionSql}) and (${boundSql}) order by ${quoteIdentifier(column)} ${NEAREST_OPERATORS[metric as keyof typeof NEAREST_OPERATORS]} $${probeIndex}::vector limit ${limit}`,
				parameters
			});
			return result.rows.map((row) => {
				if (!Schema.is(JsonObject)(row)) return row;
				const record = Object.fromEntries(
					Object.entries(row).filter(([field]) => field !== 'distance')
				);
				const distance = row['distance'];
				const measured = typeof distance === 'number' ? distance : Number(distance ?? Number.NaN);
				return { ...access.mask(subject, 'read', input.collection, record), distance: measured };
			});
		});
		/**
		 * A column value as a parameter, and the placeholder that receives it.
		 *
		 * A driver binds a JavaScript array to a Postgres *array*, so a `jsonb` column handed
		 * `[{ start_at, end_at }]` receives array-literal syntax and answers `invalid input syntax for
		 * type json`. An object does not take that path — a driver serialises it — which is why only
		 * list-valued JSON columns were broken, and why nothing caught it until a workspace stored one:
		 * `time_entries.worked_intervals` is a list, so no attendance record could be written or
		 * corrected through the runtime at all.
		 *
		 * The decision is the *column's* declared type, never the value's JavaScript type. A model can
		 * declare a real Postgres array with `.array()`, and a value bound for one must stay an array —
		 * encoding it as JSON because it happened to arrive as a list would corrupt exactly the column
		 * the driver was already handling correctly.
		 */
		const isJsonColumn = (
			definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
			column: string
		): boolean => definition.fields[column]?.type === 'json';
		const boundParameter = (
			definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
			column: string,
			value: Schema.Json
		): Schema.Json =>
			isJsonColumn(definition, column) && Array.isArray(value) ? JSON.stringify(value) : value;
		const boundPlaceholder = (
			definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
			column: string,
			value: Schema.Json,
			position: number
		): string =>
			`$${position}${isJsonColumn(definition, column) && Array.isArray(value) ? '::jsonb' : ''}`;

		/**
		 * Every statement one create is, without executing any of them.
		 *
		 * Extracted so a batch can be one round trip rather than N. The row, its history entry, its
		 * sync outbox row and its integration deliveries have to land together — a record visible to
		 * the sync engine but absent from history is a worse state than no record — and the only way
		 * to say "together" through this facility is to hand it one `Transaction`. Building the
		 * statements separately from running them is what lets a batch concatenate several rows'
		 * worth into that one transaction instead of opening one per row.
		 */
		const createStatements = (
			effectId: EffectId,
			subject: Identity.Subject,
			input: MutationInput,
			definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
			visibility: AccessControl.RowPredicate
		): ReadonlyArray<{
			readonly sql: string;
			readonly parameters: ReadonlyArray<Schema.Json>;
		}> => {
			const writable = writableValues(input.values, definition);
			const entries = Object.entries(writable).sort(([left], [right]) => left.localeCompare(right));
			const columns = ['norbital_id', ...entries.map(([name]) => name)];
			const columnValues: ReadonlyArray<readonly [string, Schema.Json]> = [
				['norbital_id', input.id],
				...entries.map(([name, value]) => [name, value] as const)
			];
			const parameters: ReadonlyArray<Schema.Json> = [
				...columnValues.map(([name, value]) => boundParameter(definition, name, value)),
				...visibility.parameters
			];
			const history = definition.history
				? [
						{
							sql: 'insert into bolt_collection_history (collection_name, record_id, operation, subject_id, snapshot) values ($1, $2, $3, $4, $5)',
							parameters: [input.collection, input.id, 'create', subject.userId, input.values]
						}
					]
				: [];
			return [
				{
					sql: `insert into ${quoteIdentifier(input.collection)} (${columns.map(quoteIdentifier).join(', ')}) select ${columnValues.map(([name, value], index) => boundPlaceholder(definition, name, value, index + 1)).join(', ')} where ${offsetParameters(visibility.sql, columns.length)}`,
					parameters
				},
				...history,
				{
					sql: 'insert into bolt_sync_outbox (collection_name, record_id, operation, record) values ($1, $2, $3, $4)',
					parameters: [input.collection, input.id, 'create', input.values]
				},
				...outboxStatements(
					effectId,
					subject,
					input.collection,
					input.id,
					'create',
					input.values,
					undefined
				)
			];
		};
		/**
		 * Many creates, as one transaction and one announcement.
		 *
		 * The predicate is evaluated per row, exactly as a single create evaluates it — each row
		 * carries its own `where` and a row the subject may not write inserts nothing, while the rest
		 * of the batch proceeds. That is the same outcome N separate creates would produce, reached in
		 * one round trip instead of N.
		 *
		 * One `wake.announce` at the end rather than one per row: the announcement says a collection
		 * changed, and saying it two hundred times says nothing more than saying it once.
		 */
		/**
		 * One transaction for rows that may span several collections.
		 *
		 * This is the only thing that writes a created row — a single `create`, a batch, and a nested
		 * graph all arrive here. A flattened graph is a payroll run, its payslips, their lines and
		 * their source claims, and all of them have to land together or the run is a fact its payslips
		 * are not. So the statements are collected in the order
		 * `flattenGraph` produced them — parent before child, because a foreign key must already name
		 * a row — and issued once.
		 *
		 * The collection definition and the visibility predicate are resolved per node rather than
		 * per call, because the nodes are not all the same collection any more. Elevation is honoured
		 * the same way it always was: it relaxes the row predicate for a hook's own follow-ups, never
		 * the question of whether this subject may write here at all, which `mutate` has already
		 * asked.
		 */
		const applyGraph = Effect.fn('Collections.applyGraph')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			nodes: ReadonlyArray<{
				readonly collection: string;
				readonly id: string;
				readonly values: Readonly<Record<string, Schema.Json>>;
			}>,
			elevated: boolean
		) {
			if (nodes.length === 0) return;
			const statements: Array<ReturnType<typeof createStatements>[number]> = [];
			const touched = new Set<string>();
			for (const node of nodes) {
				const definition = yield* workspace.collection(node.collection);
				const visibility = elevated
					? AccessControl.unrestricted
					: access.predicate(subject, 'create', node.collection);
				statements.push(
					...createStatements(
						effectId,
						subject,
						{ collection: node.collection, id: node.id, values: node.values },
						definition,
						visibility
					)
				);
				touched.add(node.collection);
			}
			for (const collection of touched) yield* announceFlush(effectId, collection, 'create');
			yield* database.execute(effectId, { _tag: 'Transaction', statements });
			yield* wake.announce(effectId, [...touched]);
		});
		const applyUpdate = Effect.fn('Collections.applyUpdate')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			input: MutationInput,
			definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
			clearLock: boolean,
			elevated = false,
			/** The row before this update, when an outbound binding on this collection needs one. */
			previous: Readonly<Record<string, unknown>> | undefined = undefined
		) {
			const visibility = elevated
				? AccessControl.unrestricted
				: access.predicate(subject, 'update', input.collection);
			const writable = writableValues(input.values, definition);
			const entries = Object.entries(writable).sort(([left], [right]) => left.localeCompare(right));
			if (entries.length === 0 && !clearLock) return;
			const assignments = [
				...entries.map(
					([name, value], index) =>
						`${quoteIdentifier(name)} = ${boundPlaceholder(definition, name, value, index + 1)}`
				),
				'norbital_updated_at = now()',
				'norbital_row_version = norbital_row_version + 1',
				...(clearLock ? ['norbital_approval_id = null'] : [])
			];
			const history = definition.history
				? [
						{
							sql: 'insert into bolt_collection_history (collection_name, record_id, operation, subject_id, snapshot) values ($1, $2, $3, $4, $5)',
							parameters: [input.collection, input.id, 'update', subject.userId, input.values]
						}
					]
				: [];
			yield* announceFlush(effectId, input.collection, 'update');
			yield* database.execute(effectId, {
				_tag: 'Transaction',
				statements: [
					{
						sql: `update ${quoteIdentifier(input.collection)} set ${assignments.join(', ')} where norbital_id = $${entries.length + 1} and (${offsetParameters(visibility.sql, entries.length + 1)})`,
						parameters: [
							...entries.map(([name, value]) => boundParameter(definition, name, value)),
							input.id,
							...visibility.parameters
						]
					},
					...history,
					{
						sql: 'insert into bolt_sync_outbox (collection_name, record_id, operation, record) values ($1, $2, $3, $4)',
						parameters: [input.collection, input.id, 'update', input.values]
					},
					...outboxStatements(
						effectId,
						subject,
						input.collection,
						input.id,
						'update',
						input.values,
						previous
					)
				]
			});
			yield* wake.announce(effectId, [input.collection]);
		});
		const applyDelete = Effect.fn('Collections.applyDelete')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			collection: string,
			id: string,
			definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
			elevated = false,
			/** The row before this delete, when an outbound binding on this collection needs one. */
			previous: Readonly<Record<string, unknown>> | undefined = undefined
		) {
			const visibility = elevated
				? AccessControl.unrestricted
				: access.predicate(subject, 'delete', collection);
			const history = definition.history
				? [
						{
							sql: 'insert into bolt_collection_history (collection_name, record_id, operation, subject_id) values ($1, $2, $3, $4)',
							parameters: [collection, id, 'delete', subject.userId]
						}
					]
				: [];
			yield* announceFlush(effectId, collection, 'delete');
			yield* database.execute(effectId, {
				_tag: 'Transaction',
				statements: [
					{
						sql: `delete from ${quoteIdentifier(collection)} where norbital_id = $1 and (${offsetParameters(visibility.sql, 1)})`,
						parameters: [id, ...visibility.parameters]
					},
					...history,
					{
						sql: 'insert into bolt_sync_outbox (collection_name, record_id, operation) values ($1, $2, $3)',
						parameters: [collection, id, 'delete']
					},
					...outboxStatements(effectId, subject, collection, id, 'delete', {}, previous)
				]
			});
			yield* wake.announce(effectId, [collection]);
		});
		const readLock = Effect.fn('Collections.readLock')(function* (
			effectId: EffectId,
			collection: string,
			id: string
		) {
			const result = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `select norbital_approval_id from ${quoteIdentifier(collection)} where norbital_id = $1`,
				parameters: [id]
			});
			const row = result.rows[0];
			const value =
				typeof row === 'object' && row !== null
					? Reflect.get(row, 'norbital_approval_id')
					: undefined;
			return typeof value === 'string' && value.length > 0 ? value : undefined;
		});
		const setLock = Effect.fn('Collections.setLock')(function* (
			effectId: EffectId,
			collection: string,
			id: string,
			requestId: string
		) {
			yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `update ${quoteIdentifier(collection)} set norbital_approval_id = $2 where norbital_id = $1 and norbital_approval_id is null returning norbital_id`,
				parameters: [id, requestId]
			});
		});
		/**
		 * Releases a record held by an approval, without touching anything else on it.
		 *
		 * `applyUpdate` can clear the lock as part of a write, which is how an approved *update* settles
		 * — it has values to apply anyway. An approved *create* has none: the row was written when the
		 * create was intercepted, so the only thing left to change is that it is no longer held.
		 */
		const releaseLock = Effect.fn('Collections.releaseLock')(function* (
			effectId: EffectId,
			collection: string,
			id: string
		) {
			yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `update ${quoteIdentifier(collection)} set norbital_approval_id = null where norbital_id = $1 returning norbital_id`,
				parameters: [id]
			});
		});
		const holdForApproval = Effect.fn('Collections.holdForApproval')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			input: MutationInput,
			action: typeof CollectionAction.Type
		) {
			const pending = yield* approvals.pendingForRecord(effectId, input.collection, input.id);
			if (pending !== undefined) {
				return yield* new ApprovalConflict({
					requestId: pending.requestId,
					reason: 'record is locked by a pending approval'
				});
			}
			if (action !== 'create') {
				const locked = yield* readLock(effectId, input.collection, input.id);
				if (locked !== undefined) {
					return yield* new ApprovalConflict({
						requestId: locked,
						reason: 'record is locked by a pending approval'
					});
				}
			}
			// Derived, not random: the same interception must resolve to the same request so a retry
			// re-joins its approval instead of opening a second one. It has to be a UUID because
			// `approval_request` is a collection like any other, keyed by `norbital_id uuid` — the
			// composite string only ever fit while Bolt's invented `id text` accepted anything.
			const requestId = deriveRecordId(`${input.collection}:${input.id}:${effectId}`);
			const state = yield* approvals.request(effectId, subject, requestId, {
				collection: input.collection,
				id: input.id,
				values: input.values,
				action,
				subject
			});
			if (state._tag !== 'Pending') {
				return yield* new ApprovalConflict({
					requestId: state.requestId,
					reason: 'record is locked by a pending approval'
				});
			}
			// Every action locks, `create` included. The row a gated create produces exists before this
			// runs — see `create` below — so there is something to stamp, and stamping it is what makes
			// the record visible-but-held rather than absent.
			yield* setLock(effectId, input.collection, input.id, state.requestId);
			return yield* new PendingApproval({
				requestId: state.requestId,
				collection: input.collection,
				id: input.id,
				action
			});
		});
		const requiresApproval = (
			definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
			visibility: AccessControl.RowPredicate
		): boolean => definition.approvalLock === true || visibility.approval !== undefined;
		const create = Effect.fn('Collections.create')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			input: MutationInput,
			depth = 0
		) {
			yield* refuseRunawayHooks('create', input.collection, depth);
			const definition = yield* workspace.collection(input.collection);
			yield* access.authorize(subject, 'create', input.collection);
			const visibility = access.predicate(subject, 'create', input.collection);
			const module = authored.hooks[input.collection];
			/**
			 * A gated create writes the row and then locks it, rather than holding the operation and
			 * writing nothing.
			 *
			 * Holding was the earlier design and it had two costs that only show up on a real workspace.
			 * The row did not exist, so there was nothing for a reviewer to open, nothing for the table
			 * to show a pending badge on, and nothing for `approvals.process` to be invoked from — the
			 * decision UI keys off `norbital_approval_id` on a visible row. And because the operation was
			 * stored before any hook ran, the stored values were only what the form posted: `payroll_runs`
			 * derives six `not null` columns in `create.before`, so replaying that operation later
			 * inserted a row that could not satisfy its own schema, and `create.after` — which is what
			 * starts the payroll engine — never ran at all.
			 *
			 * So the hooks run first and the row is written exactly as an ungated create would write it.
			 * What approval changes is not whether the record exists but whether it is settled: the lock
			 * `holdForApproval` stamps is what every later mutation checks, so the record can still be
			 * moved, but only through the approval it is held by.
			 */
			// A create is a batch of one, and takes the batch's path rather than a shorter one of its
			// own: decode, load, hook. `load` over a single input costs one call and, where a
			// collection declares none, nothing at all.
			const decoded = yield* decodeCreateInput(input.collection, input.values, module);
			const prepared = yield* runCreatePrepare(
				effectId,
				subject,
				input.collection,
				[decoded],
				module,
				depth
			);
			const values = yield* runCreateHooks(
				effectId,
				subject,
				{ ...input, values: decoded },
				module,
				depth,
				prepared
			);
			// The same path a batch takes, because a create *is* a batch of one — and because a
			// `create.before` that returns the records belonging to this one has to commit them with
			// it. `payroll_runs` is created one at a time through this function, and its run row was
			// a fact three transactions before its payslips were.
			yield* applyGraph(
				effectId,
				subject,
				yield* flattenGraph(input.collection, values, input.id, 0),
				false
			);
			if (requiresApproval(definition, visibility)) {
				return yield* holdForApproval(effectId, subject, { ...input, values }, 'create');
			}
			if (module?.create?.perRecord?.after !== undefined) {
				const api = buildApi(effectId, subject, true, depth + 1);
				const record = yield* readRowElevated(effectId, input.collection, input.id);
				yield* runHook<unknown>(module.create.perRecord.after, { record, api }, api, {
					collection: input.collection,
					action: 'create.after'
				});
			}
			yield* emitChangeEvents(effectId, subject, input.collection, input.id, 'created');
		});
		const createMany = Effect.fn('Collections.createMany')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			inputs: ReadonlyArray<MutationInput>
		) {
			for (let index = 0; index < inputs.length; index += 1) {
				const input = inputs[index];
				if (input !== undefined)
					yield* create(EffectId.make(`${effectId}:${index}`), subject, input);
			}
		});
		/**
		 * Every batched write, and the only path a batch takes.
		 *
		 * Two things were wrong with what this replaces, and they pulled in opposite directions.
		 *
		 * **It cost O(N) round trips to do an O(1) job.** The write is one transaction — that part was
		 * right — and then the batch read every row back one at a time, ran every `after` hook off its
		 * own second read of the same row, and emitted every change event in a sequential loop of its
		 * own. Measured on a real payroll run: 89 rows, 18.1 seconds, of which the transaction was
		 * milliseconds. Every one of those reads is an RPC out of the guest isolate before it is a
		 * query. A batch now costs one transaction, one read-back, and one enqueue, whatever N is, and
		 * `mutation-facility-budget.test.ts` fails if that stops being true.
		 *
		 * **It wrote updates as inserts.** `ElevatedMutationPayload` has always declared
		 * `{ norbital_id } & update` as an alternative to an insert, and every payload went through
		 * `runCreateHooks` and `createStatements` regardless — so an update ran the create hooks and
		 * then collided with its own primary key. Payloads are routed by `norbital_id` now.
		 *
		 * The shape:
		 *
		 * ```
		 * ┌─ PREPARE ── before hooks, outside the transaction ─┐
		 * ├─ COMMIT ─── one Transaction ──────────────────────┤
		 * └─ SETTLE ─── one read-back · after hooks · one enqueue
		 * ```
		 *
		 * Each of the three names itself in the failure it raises, through `MutationPhaseFailure`.
		 * The distinction a caller needs is not which error but which side of the transaction it
		 * happened on: `prepare` and `commit` wrote nothing and may be retried, `settle` did write
		 * and must not be, and only the phase can say which.
		 *
		 *
		 * `batchSize` cuts the payloads into batches that each get all three phases and their own
		 * transaction. Batches run in sequence: two concurrent batches into one table contend on the
		 * same rows, and stopping at a failure needs a defined frontier to stop at. A batch is also
		 * the unit the host's CPU-span budget sees, because the transaction at its end is a facility
		 * call and a facility call is what ends a span.
		 *
		 * `elevated` is honoured rather than assumed, so the same function is correct for a hook
		 * running as an ordinary subject.
		 */
		/**
		 * How deep one nested write may go.
		 *
		 * The compile-time twin of this bound is the `Depth` countdown in `contracts-schema.ts`; the
		 * two are the same number for the same reason. `relations` is a graph with cycles in it —
		 * `payroll_runs → payslips → payroll_runs` — so without a bound a returned graph that closed a
		 * loop would be walked until the isolate died. Refused during preparation, with nothing
		 * written, which is the whole advantage of doing this before the transaction rather than
		 * inside it.
		 */
		const GRAPH_DEPTH_LIMIT = 5;
		/** One node of a flattened graph: which collection it belongs to, its id, and its columns. */
		type FlatRow = {
			readonly collection: string;
			readonly id: string;
			readonly values: Readonly<Record<string, Schema.Json>>;
		};
		/**
		 * Splits one authored graph into the rows it names, parent first.
		 *
		 * A `create.before` may return its own columns and, keyed by the relation names declared in
		 * `+relationship.ts`, the records that belong to it. This is where that becomes rows: each
		 * node is given its id here rather than by whoever wrote it, because a child cannot carry a
		 * foreign key to a parent whose id does not exist yet — which is the reason the client may no
		 * longer mint one either.
		 *
		 * **An unrecognised key is refused, never dropped.** TypeScript catches a misspelled relation
		 * name when the handler returns an object literal, and cannot when the handler builds its
		 * result in a variable — which the payroll engine must, computing for a second and a half
		 * before it has one. So the guarantee is completed here: a key that is neither a column of the
		 * collection nor one of its declared relations fails the write and says which key it was. The
		 * alternative is the failure this whole design exists to end — a value that was computed,
		 * returned, and silently never stored.
		 */
		const flattenGraph: (
			collection: string,
			values: Readonly<Record<string, unknown>>,
			id: string,
			depth: number
		) => Effect.Effect<
			ReadonlyArray<FlatRow>,
			Workspace.WorkspaceLookupError | AuthoredRefusal
		> = Effect.fn('Collections.flattenGraph')(function* (
			collection: string,
			values: Readonly<Record<string, unknown>>,
			id: string,
			depth: number
		) {
			if (depth > GRAPH_DEPTH_LIMIT)
				return yield* Effect.fail(
					new AuthoredRefusal({
						message: `A nested write on ${collection} is more than ${GRAPH_DEPTH_LIMIT} levels deep. A record that owns records that own records that far is usually a cycle in +relationship.ts rather than a shape anybody meant to write.`,
						collection,
						action: 'create'
					})
				);
			const definition = yield* workspace.collection(collection);
			const relations = workspace.definition.relations ?? [];
			const own: Record<string, Schema.Json> = {};
			const nested: Array<{
				readonly collection: string;
				readonly column: string;
				readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
			}> = [];
			for (const [key, value] of Object.entries(values)) {
				if (key in definition.fields || key.startsWith('norbital_')) {
					own[key] = value as Schema.Json;
					continue;
				}
				// Read against the relation's *declared* name, and only where this collection is the
				// source and the edge is a `many` with an endpoint. A `one` relation points at a record
				// that has to exist already, so expanding it inline would mean inventing its target.
				const relation = relations.find(
					(candidate) =>
						candidate.name === key &&
						candidate.source === collection &&
						candidate.cardinality === 'many' &&
						candidate.from?.column !== undefined
				);
				if (relation === undefined)
					return yield* Effect.fail(
						new AuthoredRefusal({
							message: `${collection} has no column or declared relation named "${key}". A create hook returned it, so it would otherwise have been dropped on the way to the database.`,
							collection,
							action: 'create'
						})
					);
				if (!Array.isArray(value))
					return yield* Effect.fail(
						new AuthoredRefusal({
							message: `"${key}" is a many relation on ${collection}, so it is written as a list of records.`,
							collection,
							action: 'create'
						})
					);
				nested.push({
					collection: relation.target,
					column: relation.from?.column ?? '',
					rows: value as ReadonlyArray<Readonly<Record<string, unknown>>>
				});
			}
			// Parent first, and the order is load-bearing rather than tidy: the statements are applied
			// in the order they are collected, so a child's foreign key must already name a row.
			const rows: Array<FlatRow> = [{ collection, id, values: own }];
			for (const child of nested)
				for (const row of child.rows)
					rows.push(
						...(yield* flattenGraph(
							child.collection,
							// The link the author did not write and could not have: it is this parent's id,
							// minted a moment ago. A value they *did* write for it is overwritten rather
							// than honoured — the type omits the column for exactly this reason.
							{ ...row, [child.column]: id },
							globalThis.crypto.randomUUID(),
							depth + 1
						))
					);
			return rows;
		});
		const mutateBatch = Effect.fn('Collections.mutateBatch')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			collection: string,
			identified: ReadonlyArray<{
				readonly id: string;
				readonly values: Readonly<Record<string, Schema.Json>>;
			}>,
			definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
			elevated: boolean,
			depth: number
		) {
			const module = authored.hooks[collection];
			/**
			 * One effect id per row, never the batch's.
			 *
			 * The database facility is idempotent on `(scope, effectId)` — that is what makes a
			 * retried invocation safe — so N statements issued under one id are one statement and
			 * N cached copies of its result. An earlier implementation ran every row's `applyCreate`
			 * under the batch id, which is that fault directly.
			 */
			const rowId = (index: number): EffectId => EffectId.make(`${effectId}:mutate:${index}`);
			/**
			 * PREPARE, and the FLATTEN that finishes it. Outside the transaction, so any refusal fails
			 * the batch with nothing written rather than half applied.
			 *
			 * Decoded, then prepared, then the per-record hooks. `prepare` is the one place a batch is
			 * visible to authored code, and it exists so the *reads* can be batched while every rule
			 * stays written once, for one record — four thousand rows asking "is this day owned by
			 * leave" become one query over the window they span.
			 *
			 * FLATTEN turns every prepared graph into rows, parent first. Where a hook returned only
			 * its own columns this is one row and costs nothing; where it returned the records that
			 * belong to it — a payroll run and its payslips, an agreement and its instalments — every
			 * one of them joins the same transaction below. That is the whole point of doing it here:
			 * the parent is not a fact until its children are. It sits inside this phase rather than
			 * beside it because it writes nothing, which is the only thing the phase tag promises.
			 */
			const preparation = yield* Effect.gen(function* () {
				const decoded = yield* Effect.all(
					identified.map((row) => decodeCreateInput(collection, row.values, module)),
					{ concurrency: 'unbounded' }
				);
				const prepared = yield* runCreatePrepare(
					effectId,
					subject,
					collection,
					decoded,
					module,
					depth
				);
				const built = yield* Effect.all(
					identified.map((row, index) =>
						runCreateHooks(
							rowId(index),
							subject,
							{ collection, id: row.id, values: decoded[index] ?? row.values },
							module,
							depth,
							prepared
						).pipe(Effect.map((values) => ({ id: row.id, values })))
					),
					{ concurrency: 'unbounded' }
				);
				const flattened = yield* Effect.all(
					built.map((row) => flattenGraph(collection, row.values, row.id, 0)),
					{ concurrency: 'unbounded' }
				);
				return { built, nodes: flattened.flat() };
			}).pipe(
				Effect.catch((cause) =>
					Effect.fail(mutationPhaseFailure('prepare', collection, [], cause))
				)
			);
			const { built, nodes } = preparation;
			// COMMIT. One transaction for the batch, whatever it grew into — and atomic, so a failure
			// here wrote nothing either. It is a phase of its own because the cause is a different
			// kind of thing: `prepare` fails on a business rule, `commit` fails on the database.
			yield* applyGraph(effectId, subject, nodes, elevated).pipe(
				Effect.catch((cause) => Effect.fail(mutationPhaseFailure('commit', collection, [], cause)))
			);
			/**
			 * SETTLE. One read, and everything downstream reads from it: an `after` hook's record and
			 * a change trigger's `incoming_record` are the same row this already holds.
			 *
			 * The transaction is behind us, so a failure from here is not a failed write — it is a
			 * completed write whose aftermath went wrong, and a caller that retries it writes the
			 * batch twice. That is why the ids the transaction carried are attached to the failure:
			 * they are the only way to find out what is now true.
			 */
			const committed = nodes.map((node) => node.id);
			return yield* Effect.gen(function* () {
				const rows = yield* readBack(effectId, collection, built);
				/**
				 * The rows that are actually there, still carrying the index they were submitted under.
				 *
				 * A row the visibility predicate refused inserted nothing, so there is no record for a
				 * hook to receive and nothing for a trigger to fire on. It is dropped here, once, and
				 * everything below reads from what is left: the `after` hooks, the change events, and
				 * the answer this batch returns. The index travels with it because `rowId(index)` is the
				 * identity every statement and every enqueued task is filed under, and it must not shift
				 * when a row ahead of it was refused.
				 */
				const settled = rows.flatMap((record, index) =>
					record === undefined ? [] : [{ index, record }]
				);
				if (module?.create?.perRecord?.after !== undefined) {
					const after = module.create.perRecord.after;
					yield* Effect.all(
						settled.map(({ index, record }) =>
							Effect.gen(function* () {
								const api = buildApi(rowId(index), subject, true, depth + 1);
								yield* runHook<unknown>(after, { record, api }, api, {
									collection,
									action: 'create.after'
								});
							})
						),
						{ concurrency: 'unbounded' }
					);
				}
				yield* emitChangeEventsMany(
					effectId,
					subject,
					collection,
					settled.map(({ index, record }) => ({ taskScope: rowId(index), row: record })),
					'created'
				);
				return settled.map(({ record }) => record);
			}).pipe(
				Effect.catch((cause) =>
					Effect.fail(mutationPhaseFailure('settle', collection, committed, cause))
				)
			);
		});
		/**
		 * How many rows one call may write before it has to say how it wants them cut up.
		 *
		 * A transaction is serialised into a single `postMessage` out of the isolate, and that encode
		 * is the one stretch of a batch that cannot be broken up without breaking the transaction —
		 * so it is the one place batch size is load-bearing for the host's 2s span budget rather than
		 * merely for how much a failure loses. Exceeding it is refused rather than split silently:
		 * splitting would break the only promise this surface makes, and it would break it at exactly
		 * the size where nobody is still watching.
		 */
		const MAX_BATCH_ROWS = 5_000;
		const mutate = Effect.fn('Collections.mutate')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			collection: string,
			payloads: ReadonlyArray<Readonly<Record<string, unknown>>>,
			elevated: boolean,
			depth: number,
			options?: { readonly batchSize?: number }
		) {
			yield* refuseRunawayHooks('create', collection, depth);
			const definition = yield* workspace.collection(collection);
			// The same gate a single create passes, and it is not skipped by elevation: elevation
			// relaxes the *row* predicate for a hook's own follow-ups, never the question of whether
			// this subject may create in this collection at all.
			yield* access.authorize(subject, 'create', collection);
			/**
			 * Updates are not inserts, and this is where they stop being treated as one.
			 *
			 * They go through `update` a row at a time rather than joining the batch transaction.
			 * That is correct and it is not yet cheap; making an update batch co-transactional with an
			 * insert batch needs `applyUpdate`'s statement building lifted out of its own transaction,
			 * which is the next piece of this work rather than part of it.
			 */
			const updates = payloads.filter(
				(payload) => typeof payload['norbital_id'] === 'string'
			) as ReadonlyArray<Readonly<Record<string, Schema.Json>>>;
			const inserts = payloads.filter((payload) => typeof payload['norbital_id'] !== 'string');
			const updated: Array<Readonly<Record<string, unknown>>> = [];
			for (let index = 0; index < updates.length; index += 1) {
				const payload = updates[index];
				if (payload === undefined) continue;
				const { norbital_id: id, ...values } = payload;
				yield* update(
					EffectId.make(`${effectId}:update:${index}`),
					subject,
					{ collection, id: String(id), values },
					depth
				);
			}
			if (updates.length > 0)
				updated.push(
					// An update whose row the predicate would not write matched nothing, exactly as a
					// refused insert does, and there is no stored row to answer with. It is left out
					// rather than answered with the patch that was submitted; every payload here names
					// its own `norbital_id`, so a caller comparing what it sent against what came back
					// can still say which ones did not land.
					...(yield* readBack(
						EffectId.make(`${effectId}:update:readback`),
						collection,
						updates.map((payload) => ({ id: String(payload['norbital_id']), values: payload }))
					)).filter((row) => row !== undefined)
				);
			const identified = inserts.map((payload) => ({
				id: globalThis.crypto.randomUUID(),
				values: payload as Readonly<Record<string, Schema.Json>>
			}));
			// An approval-gated collection is written one row at a time, through `create`, because what
			// a gate does to a create is not "write it" — it writes the row and then holds it under an
			// approval, and each held row is its own request. Batching that would either lose the holds
			// or invent one request covering rows a reviewer has to decide on separately.
			if (requiresApproval(definition, access.predicate(subject, 'create', collection))) {
				for (let index = 0; index < identified.length; index += 1) {
					const row = identified[index];
					if (row !== undefined)
						yield* create(
							EffectId.make(`${effectId}:mutate:${index}`),
							subject,
							{ collection, id: row.id, values: row.values },
							depth
						);
				}
				return [
					...updated,
					...(yield* readBack(effectId, collection, identified)).filter(
						(row) => row !== undefined
					)
				];
			}
			const size = options?.batchSize ?? identified.length;
			if (size > MAX_BATCH_ROWS)
				return yield* Effect.fail(
					new AuthoredRefusal({
						message: `A single transaction may carry ${MAX_BATCH_ROWS.toLocaleString('en')} rows; this one asks for ${size.toLocaleString('en')}. Pass a batchSize rather than relying on one transaction for all of them.`,
						collection,
						action: 'create'
					})
				);
			const written: Array<Readonly<Record<string, unknown>>> = [];
			// Sequential, deliberately. See the note above `mutateBatch`.
			for (let offset = 0; offset < identified.length; offset += Math.max(size, 1)) {
				const slice = identified.slice(offset, offset + Math.max(size, 1));
				// A single batch keeps the call's own effect id, so the ids every statement and every
				// enqueued task is filed under do not move when nobody asked for batching.
				const batchId =
					slice.length === identified.length
						? effectId
						: EffectId.make(`${effectId}:b${offset / Math.max(size, 1)}`);
				written.push(
					...(yield* mutateBatch(
						batchId,
						subject,
						collection,
						slice,
						definition,
						elevated,
						depth
					))
				);
			}
			return [...updated, ...written];
		});
		/**
		 * What the database holds for these ids, one slot per submitted row, in the order submitted.
		 *
		 * `undefined` in a slot means the row is not there, and that is a real outcome rather than an
		 * anomaly: a create's visibility predicate is a `where` on the insert, so a row the subject may
		 * not write matches nothing and inserts nothing while the rest of the batch proceeds. The read
		 * is deliberately unfiltered — it asks what exists, not what this subject may see — so an
		 * absent slot is never "stored but hidden from the reader".
		 *
		 * It used to fill an absent slot in from the caller's own submission. That handed back the
		 * payload dressed as a stored record: the write was refused, and the answer said it was a row.
		 * Everything downstream then treated the fiction as a fact — an `after` hook ran for a record
		 * that does not exist, and a change trigger was enqueued carrying it as `incoming_record`. The
		 * slot is left empty instead, and each consumer decides what an empty slot means to it; none of
		 * them may invent one.
		 */
		const readBack = Effect.fn('Collections.readBack')(function* (
			effectId: EffectId,
			collection: string,
			rows: ReadonlyArray<{
				readonly id: string;
				readonly values: Readonly<Record<string, Schema.Json>>;
			}>
		) {
			if (rows.length === 0)
				return [] as ReadonlyArray<Readonly<Record<string, unknown>> | undefined>;
			const result = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `select * from ${quoteIdentifier(collection)} where norbital_id = any($1)`,
				parameters: [rows.map((row) => row.id)]
			});
			const stored = new Map<string, Readonly<Record<string, unknown>>>();
			for (const row of result.rows) {
				if (typeof row !== 'object' || row === null) continue;
				const id = Reflect.get(row, 'norbital_id');
				if (typeof id === 'string') stored.set(id, row as Readonly<Record<string, unknown>>);
			}
			return rows.map((row) => stored.get(row.id)) as ReadonlyArray<
				Readonly<Record<string, unknown>> | undefined
			>;
		});
		const count = Effect.fn('Collections.count')(function* (effectId, subject, input) {
			const definition = yield* workspace.collection(input.collection);
			yield* access.authorize(subject, 'read', input.collection);
			const context = makeWhereContext(input.collection, definition.fields, workspace.definition);
			const compiled = yield* compiledFilter(input, context);
			// The same search the rows are read through. A count that ignored it reported the whole
			// collection under a filtered page — "1 of 335" beside three rows.
			const searched = searchClause(definition.fields, input.search, compiled.parameters.length);
			const visibility = access.predicate(subject, 'read', input.collection);
			// `after` is deliberately absent here. A count answers how large the filtered set is, which
			// is what a "1 of 335" reads from; counting only the rows past the cursor would shrink that
			// total on every page turn.
			const result = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `select count(*) as count from ${quoteIdentifier(input.collection)} where (${compiled.sql}) and (${searched.sql}) and (${offsetParameters(visibility.sql, compiled.parameters.length + searched.parameters.length)})`,
				parameters: [...compiled.parameters, ...searched.parameters, ...visibility.parameters]
			});
			const row = result.rows[0];
			const value = typeof row === 'object' && row !== null ? Reflect.get(row, 'count') : undefined;
			return typeof value === 'number' ? value : Number(value ?? 0);
		});
		const update = Effect.fn('Collections.update')(function* (effectId, subject, input, depth = 0) {
			yield* refuseRunawayHooks('update', input.collection, depth);
			const definition = yield* workspace.collection(input.collection);
			yield* access.authorize(subject, 'update', input.collection);
			const visibility = access.predicate(subject, 'update', input.collection);
			if (requiresApproval(definition, visibility)) {
				return yield* holdForApproval(effectId, subject, input, 'update');
			}
			const module = authored.hooks[input.collection];
			const api = buildApi(effectId, subject, false, depth + 1);
			let values = input.values;
			if (module?.update?.input !== undefined) {
				values = yield* Schema.decodeUnknownEffect(module.update.input)(values).pipe(
					Effect.mapError(
						(cause) =>
							new AccessControl.AccessDenied({
								action: 'update',
								resource: input.collection,
								reason: 'hook input validation failed'
							})
					)
				) as Effect.Effect<Readonly<Record<string, Schema.Json>>>;
			}
			// Read once and used twice where both want it. An outbound binding needs it because a
			// trigger is asked `previous.status !== record.status` and a patch alone cannot answer that;
			// the hook needs it because it always has. The read is skipped entirely when neither does,
			// so a collection with no `update` hook and no outbound binding costs nothing for it.
			const wantsPrevious =
				module?.update?.perRecord?.before !== undefined || needsPreviousRow(input.collection, 'update');
			const existing = wantsPrevious
				? yield* readRowElevated(effectId, input.collection, input.id)
				: undefined;
			if (module?.update?.perRecord?.before !== undefined) {
				const before = yield* runHook<unknown>(
					module.update.perRecord.before,
					{ input: values, existing, api },
					api,
					{ collection: input.collection, action: 'update.before' }
				);
				if (before !== null && before !== undefined && typeof before === 'object') {
					values = before as Readonly<Record<string, Schema.Json>>;
				}
			}
			yield* applyUpdate(
				effectId,
				subject,
				{ ...input, values },
				definition,
				false,
				false,
				existing
			);
			if (module?.update?.perRecord?.after !== undefined) {
				const afterApi = buildApi(effectId, subject, true, depth + 1);
				const record = yield* readRowElevated(effectId, input.collection, input.id);
				yield* runHook<unknown>(module.update.perRecord.after, { record, api: afterApi }, afterApi, {
					collection: input.collection,
					action: 'update.after'
				});
			}
			yield* emitChangeEvents(effectId, subject, input.collection, input.id, 'updated');
		});
		const deleteRecord = Effect.fn('Collections.delete')(
			function* (effectId, subject, collection, id, depth = 0) {
				yield* refuseRunawayHooks('delete', collection, depth);
				const definition = yield* workspace.collection(collection);
				yield* access.authorize(subject, 'delete', collection);
				const visibility = access.predicate(subject, 'delete', collection);
				if (requiresApproval(definition, visibility)) {
					return yield* holdForApproval(
						effectId,
						subject,
						{ collection, id, values: {} },
						'delete'
					);
				}
				const module = authored.hooks[collection];
				const api = buildApi(effectId, subject, false, depth + 1);
				let existing: Readonly<Record<string, unknown>> | undefined;
				if (module?.delete?.perRecord?.before !== undefined || needsPreviousRow(collection, 'delete')) {
					// An outbound delete binding needs this read for a reason no hook has: after the statement
					// runs there is no row left to describe, so a delivery that did not capture it first can
					// only say that *something* with this id is gone.
					existing = yield* readRowElevated(effectId, collection, id);
				}
				if (module?.delete?.perRecord?.before !== undefined) {
					yield* runHook<unknown>(module.delete.perRecord.before, { existing, api }, api, {
						collection,
						action: 'delete.before'
					});
				}
				const record =
					module?.delete?.perRecord?.after !== undefined
						? (existing ?? (yield* readRowElevated(effectId, collection, id)))
						: undefined;
				yield* applyDelete(effectId, subject, collection, id, definition, false, existing);
				if (module?.delete?.perRecord?.after !== undefined) {
					const afterApi = buildApi(effectId, subject, true, depth + 1);
					yield* runHook<unknown>(module.delete.perRecord.after, { record, api: afterApi }, afterApi, {
						collection,
						action: 'delete.after'
					});
				}
				yield* emitChangeEvents(effectId, subject, collection, id, 'deleted');
			}
		);
		/**
		 * The record an approval request was opened over, from whichever state the request reached.
		 *
		 * Written as one reader because `resume` and `discard` differ in what they do with the record,
		 * never in how they find it.
		 */
		const storedOperation = Effect.fn('Collections.storedOperation')(function* (
			requestId: string,
			stored: unknown
		) {
			if (stored === undefined || !Schema.is(JsonObject)(stored)) {
				return yield* new ApprovalConflict({
					requestId,
					reason: 'stored approval operation is missing'
				});
			}
			return yield* Schema.decodeUnknownEffect(CollectionOperation)({
				collection: stored.collection,
				id: stored.id,
				values: stored.values,
				action: stored.action,
				subject: stored.subject
			}).pipe(
				Effect.mapError(
					() =>
						new ApprovalConflict({ requestId, reason: 'stored approval operation is malformed' })
				)
			);
		});

		/**
		 * Undoes the provisional write behind a request that was refused.
		 *
		 * Write-then-lock means the record exists before anyone has decided about it, so a refusal has
		 * something to clean up and cannot simply be recorded. What "clean up" means depends on the
		 * action: a rejected `create` must not be allowed to become live — releasing its lock alone
		 * would publish exactly the payroll run somebody just refused — so the provisional row goes.
		 * An `update` or `delete` was never applied, so the record is already what it should be and
		 * only the lock has to come off.
		 */
		const discard = Effect.fn('Collections.discard')(function* (
			effectId: EffectId,
			requestId: string
		) {
			const state = yield* approvals.status(effectId, requestId);
			if (state === undefined)
				return yield* new ApprovalConflict({ requestId, reason: 'approval request was not found' });
			if (state._tag !== 'Rejected' && state._tag !== 'Withdrawn') {
				return yield* new ApprovalConflict({ requestId, reason: 'approval was not refused' });
			}
			const operation = yield* storedOperation(requestId, state.operation);
			const definition = yield* workspace.collection(operation.collection);
			if (operation.action === 'create') {
				yield* applyDelete(
					effectId,
					operation.subject,
					operation.collection,
					operation.id,
					definition,
					true
				);
				return;
			}
			yield* releaseLock(effectId, operation.collection, operation.id);
		});

		const resume = Effect.fn('Collections.resume')(function* (
			effectId: EffectId,
			requestId: string
		) {
			const state = yield* approvals.status(effectId, requestId);
			if (state === undefined)
				return yield* new ApprovalConflict({ requestId, reason: 'approval request was not found' });
			yield* approvals.authorizeResume(state);
			const operation = yield* storedOperation(requestId, state.operation);
			const definition = yield* workspace.collection(operation.collection);
			switch (operation.action) {
				case 'create': {
					// The row was written when the create was intercepted, so approving it releases the
					// lock rather than inserting anything — re-applying would collide with the row that is
					// already there. `create.after` runs here and not at write time because that is what
					// "approved" means for a created record: the engine, the notification, the side effect
					// the workspace attached to a real one, all of which must not fire for a record still
					// waiting on a decision.
					yield* releaseLock(effectId, operation.collection, operation.id);
					const createdModule = authored.hooks[operation.collection];
					if (createdModule?.create?.perRecord?.after !== undefined) {
						const api = buildApi(effectId, operation.subject, true);
						const record = yield* readRowElevated(effectId, operation.collection, operation.id);
						yield* runHook<unknown>(createdModule.create.perRecord.after, { record, api }, api, {
							collection: operation.collection,
							action: 'create.after'
						});
					}
					return;
				}
				case 'update':
					yield* applyUpdate(effectId, operation.subject, operation, definition, true);
					return;
				case 'delete':
					yield* applyDelete(
						effectId,
						operation.subject,
						operation.collection,
						operation.id,
						definition
					);
					return;
				default: {
					const _exhaustive: never = operation.action;
					return yield* new ApprovalConflict({
						requestId,
						reason: `unsupported stored action ${_exhaustive}`
					});
				}
			}
		});
		return Service.of({
			findMany,
			findFirst: Effect.fn('Collections.findFirst')(function* (effectId, subject, input) {
				return (yield* findMany(effectId, subject, { ...input, limit: 1 }))[0];
			}),
			findNearest,
			count,
			create,
			createMany,
			mutate: (effectId, subject, collection, payloads, elevated = false, depth = 0, options) =>
				mutate(effectId, subject, collection, payloads, elevated, depth, options),
			update,
			delete: deleteRecord,
			resume,
			discard,
			import: Effect.fn('Collections.import')(function* (effectId, subject, inputs) {
				const pipeline = authored.pipelines[inputs[0]?.collection ?? ''];
				// The handler is bound to a local before the guard, rather than reached through
				// `pipeline.import` inside the thunk below. A narrowing does not survive into a closure —
				// TypeScript has to assume `pipeline` was reassigned by the time the thunk runs — so the
				// deferred form this now takes turned a checked access into an unchecked one. On a
				// collection with no import pipeline that is a real throw, not a type complaint.
				const declared = pipeline?.import;
				if (declared !== undefined) {
					const api = buildApi(effectId, subject);
					/**
					 * The handler is given the document that was posted, not an array of them.
					 *
					 * An import is one workbook, and an authored `import` schema says so: every one of them
					 * is a `Schema.Struct` carrying the header fields the sheet is read under — the roster
					 * to attach to, the month, the legal entity, the timezone — with the rows nested
					 * inside. Those header fields have no row to ride on, which is why the document is the
					 * unit and not the row.
					 *
					 * This wrapped the values in an array, so every pipeline decoded an array against a
					 * struct and threw before reading anything. Nothing caught it: `CollectionPipelines`
					 * types the handler context as `{ input: unknown }`, so the mismatch was invisible to
					 * the compiler, and the code below already assumed one input and many rows — it
					 * resolves each output row's collection as `inputs[index] ?? inputs[0]`.
					 */
					const document = inputs[0]?.values;
					const rows = yield* runAuthoredHandler(() =>
						declared.handler({ input: document, api }, api)
					);
					if (!Array.isArray(rows)) {
						return yield* new AccessControl.AccessDenied({
							action: 'import',
							resource: inputs[0]?.collection ?? '',
							reason: 'import pipeline returned no rows'
						});
					}
					yield* createMany(
						effectId,
						subject,
						rows.map((row, index) => ({
							collection: inputs[index]?.collection ?? inputs[0]?.collection ?? '',
							id:
								typeof row === 'object' &&
								row !== null &&
								typeof Reflect.get(row, 'norbital_id') === 'string'
									? (Reflect.get(row, 'norbital_id') as string)
									: deriveRecordId(`${inputs[0]?.collection ?? ''}:${effectId}:${index}`),
							values: row as Readonly<Record<string, Schema.Json>>
						}))
					);
					return rows.length;
				}
				yield* createMany(effectId, subject, inputs);
				return inputs.length;
			}),
			export: Effect.fn('Collections.export')(function* (effectId, subject, input) {
				// Bound before the guard, for the reason `import` above is: the thunk defers the call past
				// the point where the narrowing holds.
				const declared = authored.pipelines[input.collection]?.export;
				if (declared !== undefined) {
					const api = buildApi(effectId, subject);
					const records = yield* findMany(effectId, subject, input);
					return yield* runAuthoredHandler(() => declared.handler({ records, api }, api));
				}
				return yield* findMany(effectId, subject, input);
			}) as Interface['export'],
			history: Effect.fn('Collections.history')(function* (effectId, subject, collection, id) {
				yield* workspace.collection(collection);
				yield* access.authorize(subject, 'history', collection);
				return (yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'select * from bolt_collection_history where collection_name = $1 and record_id = $2 order by sequence desc',
					parameters: [collection, id]
				})).rows;
			})
		});
	})
);

export * as Collections from './collections.js';
