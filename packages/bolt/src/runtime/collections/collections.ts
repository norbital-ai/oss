import { deriveRecordId } from '../derive-record-id.js';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { AccessControl } from '../access/access-control.js';
import { ApprovalConflict, Approvals } from '../approvals/approvals.js';
import { Database } from '../facilities/database.js';
import { SyncWake } from '../sync/wake.js';
import { AI, Files, Tasks } from '../facilities/services.js';
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
		const tasks = yield* Tasks.Service;
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
			return entries.map((entry) => ({
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
				]
			}));
		};
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
			mutate: (collection, payloads) =>
				mutateMany(effectId, subject, collection, payloads, elevated, depth),
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
				yield* tasks
					.execute(EffectId.make(`${effectId}:event:${automation.name}`), {
						_tag: 'Enqueue',
						command: `automations.${automation.name}`,
						input: {
							args: {},
							scope:
								event === 'deleted' || row === undefined
									? {}
									: { incoming_record: row as Schema.Json },
							bolt_run_as: subject
						}
					})
					.pipe(Effect.ignore);
			}
		});
		const runCreateHooks = Effect.fn('Collections.runCreateHooks')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			input: MutationInput,
			module: AuthoredCollectionHookModule | undefined,
			depth = 0
		) {
			const api = buildApi(effectId, subject, false, depth + 1);
			let values = input.values;
			if (module?.create?.input !== undefined) {
				const decoded = yield* Schema.decodeUnknownEffect(module.create.input)(values).pipe(
					Effect.mapError(
						(cause) =>
							new AccessControl.AccessDenied({
								action: 'create',
								resource: input.collection,
								reason: 'hook input validation failed'
							})
					)
				);
				values = decoded as Readonly<Record<string, Schema.Json>>;
			}
			const before = yield* runHook<unknown>(module?.create?.before, { input: values, api }, api, {
				collection: input.collection,
				action: 'create.before'
			});
			if (before !== null && before !== undefined && typeof before === 'object') {
				values = before as Readonly<Record<string, Schema.Json>>;
			}
			return values;
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
				...outboxStatements(subject, input.collection, input.id, 'create', input.values, undefined)
			];
		};
		const applyCreate = Effect.fn('Collections.applyCreate')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			input: MutationInput,
			definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
			elevated = false
		) {
			const visibility = elevated
				? AccessControl.unrestricted
				: access.predicate(subject, 'create', input.collection);
			yield* database.execute(effectId, {
				_tag: 'Transaction',
				statements: [...createStatements(subject, input, definition, visibility)]
			});
			yield* wake.announce(effectId, [input.collection]);
		});
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
		const applyCreateMany = Effect.fn('Collections.applyCreateMany')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			collection: string,
			rows: ReadonlyArray<{
				readonly id: string;
				readonly values: Readonly<Record<string, Schema.Json>>;
			}>,
			definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
			elevated = false
		) {
			if (rows.length === 0) return;
			const visibility = elevated
				? AccessControl.unrestricted
				: access.predicate(subject, 'create', collection);
			yield* database.execute(effectId, {
				_tag: 'Transaction',
				statements: rows.flatMap((row) => [
					...createStatements(
						subject,
						{ collection, id: row.id, values: row.values },
						definition,
						visibility
					)
				])
			});
			yield* wake.announce(effectId, [collection]);
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
					...outboxStatements(subject, input.collection, input.id, 'update', input.values, previous)
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
					...outboxStatements(subject, collection, id, 'delete', {}, previous)
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
			const values = yield* runCreateHooks(effectId, subject, input, module, depth);
			yield* applyCreate(effectId, subject, { ...input, values }, definition);
			if (requiresApproval(definition, visibility)) {
				return yield* holdForApproval(effectId, subject, { ...input, values }, 'create');
			}
			if (module?.create?.after !== undefined) {
				const api = buildApi(effectId, subject, true, depth + 1);
				const record = yield* readRowElevated(effectId, input.collection, input.id);
				yield* runHook<unknown>(module.create.after, { record, api }, api, {
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
		 * The authored `db.<collection>.mutate([...])` batch, with the same rules a single create has.
		 *
		 * It did not have them. The previous implementation mapped the payloads to N concurrent
		 * `applyCreate` calls with the elevated flag hardcoded on, and that skipped three things at
		 * once: the action check, the row predicate, and **every hook**. A workspace whose
		 * `create.before` derives six not-null columns, refuses a duplicate, or normalises a date got
		 * none of that for a batched write — so the same payload written one way was validated and
		 * derived, and written the other way went in raw. Nothing reported the difference; the rows
		 * were simply wrong, and only in the batch path.
		 *
		 * The shape now:
		 *
		 * ```
		 * ─► before ─┐
		 * ─► before ─┼─ concurrent ─► ONE transaction ─► after ─┐
		 * ─► before ─┘                                   after ─┼─ concurrent
		 *                                                after ─┘
		 * ```
		 *
		 * `before` hooks run concurrently and any refusal fails the whole batch *before* the write, so
		 * a batch is refused with nothing written rather than half applied. The write is one round
		 * trip. `after` hooks run concurrently once the rows exist, which is the earliest moment they
		 * are allowed to — an `after` hook's whole premise is that its record is a fact.
		 *
		 * `elevated` is honoured rather than assumed. It is what the after-hook surface needs and what
		 * the previous code hardcoded; passing the api's own elevation through means the same function
		 * is correct the day `mutate` is offered to a hook running as an ordinary subject.
		 */
		const mutateMany = Effect.fn('Collections.mutate')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			collection: string,
			payloads: ReadonlyArray<Readonly<Record<string, unknown>>>,
			elevated: boolean,
			depth: number
		) {
			const definition = yield* workspace.collection(collection);
			// The same gate a single create passes, and it is not skipped by elevation: elevation
			// relaxes the *row* predicate for a hook's own follow-ups, never the question of whether
			// this subject may create in this collection at all.
			yield* access.authorize(subject, 'create', collection);
			const identified = payloads.map((payload) => ({
				id:
					typeof payload['norbital_id'] === 'string'
						? payload['norbital_id']
						: globalThis.crypto.randomUUID(),
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
				return yield* readBack(effectId, collection, identified);
			}
			const module = authored.hooks[collection];
			/**
			 * One effect id per row, never the batch's.
			 *
			 * The database facility is idempotent on `(scope, effectId)` — that is what makes a
			 * retried invocation safe — so N statements issued under one id are one statement and
			 * N cached copies of its result. The previous implementation ran every row's
			 * `applyCreate` under the batch id, which is that fault directly; the hooks would
			 * inherit it here if their reads shared one.
			 */
			const rowId = (index: number): EffectId => EffectId.make(`${effectId}:mutate:${index}`);
			const prepared = yield* Effect.all(
				identified.map((row, index) =>
					runCreateHooks(
						rowId(index),
						subject,
						{ collection, id: row.id, values: row.values },
						module,
						depth
					).pipe(Effect.map((values) => ({ id: row.id, values })))
				),
				{ concurrency: 'unbounded' }
			);
			yield* applyCreateMany(effectId, subject, collection, prepared, definition, elevated);
			if (module?.create?.after !== undefined) {
				const after = module.create.after;
				yield* Effect.all(
					prepared.map((row, index) =>
						Effect.gen(function* () {
							const api = buildApi(rowId(index), subject, true, depth + 1);
							const record = yield* readRowElevated(rowId(index), collection, row.id);
							yield* runHook<unknown>(after, { record, api }, api, {
								collection,
								action: 'create.after'
							});
						})
					),
					{ concurrency: 'unbounded' }
				);
			}
			// Announced per row, because a change event names a record: a subscriber watching one row
			// has no way to read "the collection changed" as news about theirs.
			for (let index = 0; index < prepared.length; index += 1) {
				const row = prepared[index];
				if (row !== undefined)
					yield* emitChangeEvents(rowId(index), subject, collection, row.id, 'created');
			}
			return yield* readBack(effectId, collection, prepared);
		});
		/** The written rows as they now stand, falling back to what was submitted when one is invisible. */
		const readBack = Effect.fn('Collections.readBack')(function* (
			effectId: EffectId,
			collection: string,
			rows: ReadonlyArray<{
				readonly id: string;
				readonly values: Readonly<Record<string, Schema.Json>>;
			}>
		) {
			const read: Array<Readonly<Record<string, unknown>>> = [];
			for (const [index, row] of rows.entries()) {
				// Each read under its own id, for the reason the writes are: the facility answers a
				// repeated `(scope, effectId)` out of its idempotency cache, so N reads sharing one id
				// would be one read and N copies of the first row.
				const stored = yield* readRowElevated(
					EffectId.make(`${effectId}:read:${index}`),
					collection,
					row.id
				);
				read.push(
					stored ?? ({ norbital_id: row.id, ...row.values } as Readonly<Record<string, unknown>>)
				);
			}
			return read as ReadonlyArray<Readonly<Record<string, unknown>>>;
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
				module?.update?.before !== undefined || needsPreviousRow(input.collection, 'update');
			const existing = wantsPrevious
				? yield* readRowElevated(effectId, input.collection, input.id)
				: undefined;
			if (module?.update?.before !== undefined) {
				const before = yield* runHook<unknown>(
					module.update.before,
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
			if (module?.update?.after !== undefined) {
				const afterApi = buildApi(effectId, subject, true, depth + 1);
				const record = yield* readRowElevated(effectId, input.collection, input.id);
				yield* runHook<unknown>(module.update.after, { record, api: afterApi }, afterApi, {
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
				if (module?.delete?.before !== undefined || needsPreviousRow(collection, 'delete')) {
					// An outbound delete binding needs this read for a reason no hook has: after the statement
					// runs there is no row left to describe, so a delivery that did not capture it first can
					// only say that *something* with this id is gone.
					existing = yield* readRowElevated(effectId, collection, id);
				}
				if (module?.delete?.before !== undefined) {
					yield* runHook<unknown>(module.delete.before, { existing, api }, api, {
						collection,
						action: 'delete.before'
					});
				}
				const record =
					module?.delete?.after !== undefined
						? (existing ?? (yield* readRowElevated(effectId, collection, id)))
						: undefined;
				yield* applyDelete(effectId, subject, collection, id, definition, false, existing);
				if (module?.delete?.after !== undefined) {
					const afterApi = buildApi(effectId, subject, true, depth + 1);
					yield* runHook<unknown>(module.delete.after, { record, api: afterApi }, afterApi, {
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
					if (createdModule?.create?.after !== undefined) {
						const api = buildApi(effectId, operation.subject, true);
						const record = yield* readRowElevated(effectId, operation.collection, operation.id);
						yield* runHook<unknown>(createdModule.create.after, { record, api }, api, {
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
