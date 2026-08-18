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
import { eventRecord, outboxEntriesFor, sendSubscriptions, watchesOperation, type SendSubscription } from '../integrations/outbox.js';
import { compileOrderTerms, compileWhere, makeWhereContext, renderOrderBy, WhereCompileError, type OrderTerm, type WhereContext } from './where.js';
import { attachRelations } from './prefetch.js';
import {
	AuthoredRuntimeService,
	makeAuthoringApi,
	runAuthoredHandler,
	type AuthoredCollectionOps,
	type AuthoredCollectionHookModule
} from './authored.js';

export const Predicate = Schema.TaggedUnion({
	Equal: { field: Schema.NonEmptyString, value: Schema.Json },
	NotEqual: { field: Schema.NonEmptyString, value: Schema.Json },
	GreaterThan: { field: Schema.NonEmptyString, value: Schema.Json },
	In: { field: Schema.NonEmptyString, values: Schema.Array(Schema.Json) }
});
export type Predicate = typeof Predicate.Type;

export type CompiledQuery = Readonly<{ readonly sql: string; readonly parameters: ReadonlyArray<Schema.Json> }>;
export type HistoryEntry = Readonly<{ readonly collection: string; readonly recordId: string; readonly operation: 'create' | 'update' | 'delete'; readonly version: number }>;
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
	offsetParameters: (sql: string, offset: number): string => sql.replaceAll(/\$(\d+)/g, (_token, index: string) => `$${Number(index) + offset}`),
	compilePredicate: (predicate: Predicate, offset = 0): CompiledQuery => Predicate.match(predicate, {
		Equal: ({ field, value }) => ({ sql: `${CollectionSql.quoteIdentifier(field)} = $${offset + 1}`, parameters: [value] }),
		NotEqual: ({ field, value }) => ({ sql: `${CollectionSql.quoteIdentifier(field)} <> $${offset + 1}`, parameters: [value] }),
		GreaterThan: ({ field, value }) => ({ sql: `${CollectionSql.quoteIdentifier(field)} > $${offset + 1}`, parameters: [value] }),
		In: ({ field, values }) => ({ sql: values.length === 0 ? 'false' : `${CollectionSql.quoteIdentifier(field)} in (${values.map((_, index) => `$${offset + index + 1}`).join(', ')})`, parameters: values })
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

type MutationError = Workspace.WorkspaceLookupError | AccessControl.AccessDenied | Database.FacilityError | ApprovalConflict | PendingApproval;
type ResumeError = Workspace.WorkspaceLookupError | AccessControl.AccessDenied | Database.FacilityError | ApprovalConflict;
/** Query paths add the where-compiler failure so an unsupported filter surfaces instead of silently widening the result. */
type QueryError = Workspace.WorkspaceLookupError | AccessControl.AccessDenied | Database.FacilityError | WhereCompileError;

export type Interface = Readonly<{
	readonly findMany: (effectId: EffectId, subject: Identity.Subject, input: QueryInput) => Effect.Effect<ReadonlyArray<Schema.Json>, QueryError>;
	readonly findFirst: (effectId: EffectId, subject: Identity.Subject, input: QueryInput) => Effect.Effect<Schema.Json | undefined, QueryError>;
	readonly count: (effectId: EffectId, subject: Identity.Subject, input: QueryInput) => Effect.Effect<number, QueryError>;
	readonly create: (effectId: EffectId, subject: Identity.Subject, input: MutationInput) => Effect.Effect<void, MutationError>;
	readonly createMany: (effectId: EffectId, subject: Identity.Subject, inputs: ReadonlyArray<MutationInput>) => Effect.Effect<void, MutationError>;
	readonly update: (effectId: EffectId, subject: Identity.Subject, input: MutationInput) => Effect.Effect<void, MutationError>;
	readonly delete: (effectId: EffectId, subject: Identity.Subject, collection: string, id: string) => Effect.Effect<void, MutationError>;
	readonly resume: (effectId: EffectId, requestId: string) => Effect.Effect<void, ResumeError>;
	readonly import: (effectId: EffectId, subject: Identity.Subject, inputs: ReadonlyArray<MutationInput>) => Effect.Effect<number, MutationError>;
	readonly export: (effectId: EffectId, subject: Identity.Subject, input: QueryInput) => Effect.Effect<ReadonlyArray<Schema.Json>, QueryError>;
	readonly history: (effectId: EffectId, subject: Identity.Subject, collection: string, id: string) => Effect.Effect<ReadonlyArray<Schema.Json>, QueryError>;
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
	const generated = Object.entries(definition.fields).filter(([, field]) => field.generated !== undefined).map(([name]) => name);
	if (generated.length === 0) return values;
	return Object.fromEntries(Object.entries(values).filter(([name]) => !generated.includes(name)));
};

/**
 * Resolves one query's SQL predicate. A `where` object owns the answer when present; otherwise a
 * structured `predicate` does. Compilation failure is raised here so every read path reports the
 * offending column rather than running a widened query.
 */
const compiledFilter = (input: QueryInput, context: WhereContext): Effect.Effect<CompiledQuery, WhereCompileError> => {
	if (input.where === undefined) {
		return Effect.succeed(input.predicate === undefined ? { sql: 'true', parameters: [] } : compilePredicate(input.predicate));
	}
	const compiled = compileWhere(input.where, context);
	return Result.isFailure(compiled) ? Effect.fail(compiled.failure) : Effect.succeed(compiled.success);
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
		value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
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
			return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
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
		const refuse = (message: string): Result.Result<ReadonlyArray<CursorValue>, WhereCompileError> =>
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
		if (Reflect.get(payload, 'v') !== 1) return refuse('Pagination cursor was issued in a different cursor format.');
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
	seek: (terms: ReadonlyArray<OrderTerm>, values: ReadonlyArray<CursorValue>, offset: number): CompiledQuery => {
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
				clauses.push(priorValue === null ? `${priorColumn} is null` : `${priorColumn} = ${bind(priorValue)}`);
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
		const sendsByCollection = sendSubscriptions(workspace.definition.integrations, authored.integrations);
		const subscriptionsFor = (collection: string): ReadonlyArray<SendSubscription> => sendsByCollection.get(collection) ?? [];
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
				sql: "insert into bolt_integration_outbox (integration_name, binding_name, collection_name, record_id, operation, path, payload, status, last_error) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
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
		const readRowElevated = Effect.fn('Collections.readRowElevated')(function* (effectId: EffectId, collection: string, id: string) {
			const result = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `select * from ${quoteIdentifier(collection)} where norbital_id = $1`,
				parameters: [id]
			});
			const row = result.rows[0];
			return typeof row === 'object' && row !== null ? (row as Readonly<Record<string, unknown>>) : undefined;
		});
		/** Runs one authored hook handler with its context object, resolving Effect, promise, and plain results alike. */
		const runHook = <A = unknown>(hook: { readonly handler: (context: unknown, api: unknown) => unknown } | undefined, context: unknown, api: unknown): Effect.Effect<A> => {
			if (hook === undefined) return Effect.succeed(undefined as A);
			return runAuthoredHandler(hook.handler(context, api)) as Effect.Effect<A>;
		};
		/**
		 * Builds the invocation-bound authoring api from this layer's internals.
		 *
		 * The elevated form backs the after-hook `db.mutate`/`db.delete` surface: those write through
		 * the same statement paths but with no row-visibility predicate, which is the point of an
		 * after hook — the record already passed authorization, so its own follow-ups must not fail
		 * on a row filter the writer itself could not see past.
		 */
		const buildOps = (effectId: EffectId, subject: Identity.Subject, elevated = false): AuthoredCollectionOps => ({
			findMany: (collection, input) =>
				findMany(effectId, subject, { collection, ...input }).pipe(
					Effect.map((rows) => rows as ReadonlyArray<Readonly<Record<string, unknown>>>)
				),
			findFirst: (collection, input) =>
				findMany(effectId, subject, { collection, ...input, limit: 1 }).pipe(
					Effect.map((rows) => (rows[0] as Readonly<Record<string, unknown>> | undefined))
				),
			count: (collection, input) =>
				findMany(effectId, subject, { collection, ...input }).pipe(
					Effect.map((rows) => rows.length)
				),
			findNearest: (collection, input) =>
				findMany(effectId, subject, { collection, ...input }).pipe(
					Effect.map((rows) => rows as ReadonlyArray<Readonly<Record<string, unknown>>>)
				),
			create: (collection, id, values) =>
				Effect.gen(function* () {
					yield* create(effectId, subject, { collection, id, values });
					const row = yield* readRowElevated(effectId, collection, id);
					return row ?? ({ norbital_id: id, ...values } as Readonly<Record<string, unknown>>);
				}),
			update: (collection, id, values) =>
				Effect.gen(function* () {
					yield* update(effectId, subject, { collection, id, values });
					const row = yield* readRowElevated(effectId, collection, id);
					return row ?? ({ norbital_id: id, ...values } as Readonly<Record<string, unknown>>);
				}),
			delete: (collection, id) => deleteRecord(effectId, subject, collection, id),
			mutate: (collection, payloads) =>
				Effect.all(
					payloads.map((payload) =>
						Effect.gen(function* () {
							const identifier = typeof payload['norbital_id'] === 'string' ? payload['norbital_id'] : globalThis.crypto.randomUUID();
							const definition = yield* workspace.collection(collection);
							yield* applyCreate(effectId, subject, { collection, id: identifier, values: payload as Readonly<Record<string, Schema.Json>> }, definition, true);
							const row = yield* readRowElevated(effectId, collection, identifier);
							return row ?? ({ norbital_id: identifier, ...payload } as Readonly<Record<string, unknown>>);
						})
					),
					{ concurrency: 'unbounded' }
				),
			approvalFindMany: (input) =>
				findMany(effectId, subject, { collection: 'approval_request', ...input }).pipe(
					Effect.map((rows) => rows as ReadonlyArray<Readonly<Record<string, unknown>>>)
				),
			approvalFindFirst: (input) =>
				findMany(effectId, subject, { collection: 'approval_request', ...input, limit: 1 }).pipe(
					Effect.map((rows) => (rows[0] as Readonly<Record<string, unknown>> | undefined))
				),
			infer: (input) =>
				ai.execute(effectId, {
					_tag: 'Turn',
					model: input.model ?? 'gpt-5',
					messages: [{ role: 'user', content: input.prompt }],
					tools: [],
					maxOutputTokens: 4_096
				}).pipe(Effect.map((response) => Schema.decodeUnknownSync(input.schema)(response.output))),
			readFileAsset: (assetId) =>
				files.execute(effectId, { _tag: 'Read', key: assetId }).pipe(
					Effect.map((response) => ({
						id: assetId,
						name: response.key ?? assetId,
						mimeType: null,
						size: (response.bytes ?? new Uint8Array()).byteLength,
						bytes: response.bytes ?? new Uint8Array()
					}))
				)
		});
		const buildApi = (effectId: EffectId, subject: Identity.Subject, elevated = false): unknown =>
			makeAuthoringApi(buildOps(effectId, subject, elevated), { elevated });
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
				(automation) => automation.trigger._tag === 'Change' && automation.trigger.collection === collection && automation.trigger.event === event
			);
			if (triggers.length === 0) return;
			const row = event === 'deleted' ? undefined : yield* readRowElevated(effectId, collection, id);
			for (const automation of triggers) {
				yield* tasks.execute(EffectId.make(`${effectId}:event:${automation.name}`), {
					_tag: 'Enqueue',
					command: `automations.${automation.name}`,
					input: {
						args: {},
						scope: event === 'deleted' || row === undefined
							? {}
							: { incoming_record: row as Schema.Json },
						bolt_run_as: subject
					}
				}).pipe(Effect.ignore);
			}
		});
		const runCreateHooks = Effect.fn('Collections.runCreateHooks')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			input: MutationInput,
			module: AuthoredCollectionHookModule | undefined
		) {
			const api = buildApi(effectId, subject);
			let values = input.values;
			if (module?.create?.input !== undefined) {
				const decoded = yield* Schema.decodeUnknownEffect(module.create.input)(values).pipe(
					Effect.mapError((cause) => new AccessControl.AccessDenied({ action: 'create', resource: input.collection, reason: 'hook input validation failed' }))
				);
				values = decoded as Readonly<Record<string, Schema.Json>>;
			}
			const before = yield* runHook<unknown>(module?.create?.before, { input: values, api }, api);
			if (before !== null && before !== undefined && typeof before === 'object') {
				values = before as Readonly<Record<string, Schema.Json>>;
			}
			return values;
		});
		const findMany: Interface['findMany'] = Effect.fn('Collections.findMany')(function* (effectId: EffectId, subject: Identity.Subject, input: QueryInput) {
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
					parameters: [...compiled.parameters, ...searched.parameters, ...visibility.parameters, ...seek.parameters]
				});
				const rows = result.rows.map((row) => Schema.is(JsonObject)(row)
					? access.mask(subject, 'read', input.collection, row)
					: row);
				// Related records are read through `findMany` itself, so each one passes the same
				// authorization, row visibility and masking as a direct query would. `with` cannot
				// become a way to read what the subject is not allowed to see.
				return yield* attachRelations(workspace.definition, input.collection, rows, input.with, (collection, column, values) =>
					findMany(effectId, subject, {
						collection,
						where: { [column]: { in: values } },
						limit: PREFETCH_LIMIT
					}).pipe(Effect.orElseSucceed(() => []))
				);
			});
		const applyCreate = Effect.fn('Collections.applyCreate')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			input: MutationInput,
			definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
			elevated = false
		) {
			const visibility = elevated ? AccessControl.unrestricted : access.predicate(subject, 'create', input.collection);
			const writable = writableValues(input.values, definition);
			const entries = Object.entries(writable).sort(([left], [right]) => left.localeCompare(right));
			const columns = ['norbital_id', ...entries.map(([name]) => name)];
			const parameters: ReadonlyArray<Schema.Json> = [input.id, ...entries.map(([, value]) => value), ...visibility.parameters];
			const history = definition.history ? [{
				sql: 'insert into bolt_collection_history (collection_name, record_id, operation, subject_id, snapshot) values ($1, $2, $3, $4, $5)',
				parameters: [input.collection, input.id, 'create', subject.userId, input.values]
			}] : [];
			yield* database.execute(effectId, {
				_tag: 'Transaction',
				statements: [
					{
						sql: `insert into ${quoteIdentifier(input.collection)} (${columns.map(quoteIdentifier).join(', ')}) select ${columns.map((_, index) => `$${index + 1}`).join(', ')} where ${offsetParameters(visibility.sql, columns.length)}`,
						parameters
					},
					...history,
					{
						sql: 'insert into bolt_sync_outbox (collection_name, record_id, operation, record) values ($1, $2, $3, $4)',
						parameters: [input.collection, input.id, 'create', input.values]
					},
					...outboxStatements(subject, input.collection, input.id, 'create', input.values, undefined)
				]
			});
			yield* wake.announce(effectId, [input.collection]);
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
			const visibility = elevated ? AccessControl.unrestricted : access.predicate(subject, 'update', input.collection);
			const writable = writableValues(input.values, definition);
			const entries = Object.entries(writable).sort(([left], [right]) => left.localeCompare(right));
			if (entries.length === 0 && !clearLock) return;
			const assignments = [
				...entries.map(([name], index) => `${quoteIdentifier(name)} = $${index + 1}`),
				'norbital_updated_at = now()',
				'norbital_row_version = norbital_row_version + 1',
				...(clearLock ? ['norbital_approval_id = null'] : [])
			];
			const history = definition.history ? [{ sql: 'insert into bolt_collection_history (collection_name, record_id, operation, subject_id, snapshot) values ($1, $2, $3, $4, $5)', parameters: [input.collection, input.id, 'update', subject.userId, input.values] }] : [];
			yield* database.execute(effectId, { _tag: 'Transaction', statements: [
				{ sql: `update ${quoteIdentifier(input.collection)} set ${assignments.join(', ')} where norbital_id = $${entries.length + 1} and (${offsetParameters(visibility.sql, entries.length + 1)})`, parameters: [...entries.map(([, value]) => value), input.id, ...visibility.parameters] },
				...history,
				{ sql: 'insert into bolt_sync_outbox (collection_name, record_id, operation, record) values ($1, $2, $3, $4)', parameters: [input.collection, input.id, 'update', input.values] },
				...outboxStatements(subject, input.collection, input.id, 'update', input.values, previous)
			] });
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
			const visibility = elevated ? AccessControl.unrestricted : access.predicate(subject, 'delete', collection);
			const history = definition.history ? [{ sql: 'insert into bolt_collection_history (collection_name, record_id, operation, subject_id) values ($1, $2, $3, $4)', parameters: [collection, id, 'delete', subject.userId] }] : [];
			yield* database.execute(effectId, { _tag: 'Transaction', statements: [
				{ sql: `delete from ${quoteIdentifier(collection)} where norbital_id = $1 and (${offsetParameters(visibility.sql, 1)})`, parameters: [id, ...visibility.parameters] },
				...history,
				{ sql: 'insert into bolt_sync_outbox (collection_name, record_id, operation) values ($1, $2, $3)', parameters: [collection, id, 'delete'] },
				...outboxStatements(subject, collection, id, 'delete', {}, previous)
			] });
			yield* wake.announce(effectId, [collection]);
		});
		const readLock = Effect.fn('Collections.readLock')(function* (effectId: EffectId, collection: string, id: string) {
			const result = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `select norbital_approval_id from ${quoteIdentifier(collection)} where norbital_id = $1`,
				parameters: [id]
			});
			const row = result.rows[0];
			const value = typeof row === 'object' && row !== null ? Reflect.get(row, 'norbital_approval_id') : undefined;
			return typeof value === 'string' && value.length > 0 ? value : undefined;
		});
		const setLock = Effect.fn('Collections.setLock')(function* (effectId: EffectId, collection: string, id: string, requestId: string) {
			yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `update ${quoteIdentifier(collection)} set norbital_approval_id = $2 where norbital_id = $1 and norbital_approval_id is null returning norbital_id`,
				parameters: [id, requestId]
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
				return yield* new ApprovalConflict({ requestId: pending.requestId, reason: 'record is locked by a pending approval' });
			}
			if (action !== 'create') {
				const locked = yield* readLock(effectId, input.collection, input.id);
				if (locked !== undefined) {
					return yield* new ApprovalConflict({ requestId: locked, reason: 'record is locked by a pending approval' });
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
				return yield* new ApprovalConflict({ requestId: state.requestId, reason: 'record is locked by a pending approval' });
			}
			if (action !== 'create') {
				yield* setLock(effectId, input.collection, input.id, state.requestId);
			}
			return yield* new PendingApproval({ requestId: state.requestId, collection: input.collection, id: input.id, action });
		});
		const requiresApproval = (
			definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
			visibility: AccessControl.RowPredicate
		): boolean => definition.approvalLock === true || visibility.approval !== undefined;
		const create = Effect.fn('Collections.create')(function* (effectId: EffectId, subject: Identity.Subject, input: MutationInput) {
			const definition = yield* workspace.collection(input.collection);
			yield* access.authorize(subject, 'create', input.collection);
			const visibility = access.predicate(subject, 'create', input.collection);
			if (requiresApproval(definition, visibility)) {
				return yield* holdForApproval(effectId, subject, input, 'create');
			}
			const module = authored.hooks[input.collection];
			const values = yield* runCreateHooks(effectId, subject, input, module);
			yield* applyCreate(effectId, subject, { ...input, values }, definition);
			if (module?.create?.after !== undefined) {
				const api = buildApi(effectId, subject, true);
				const record = yield* readRowElevated(effectId, input.collection, input.id);
				yield* runHook<unknown>(module.create.after, { record, api }, api);
			}
			yield* emitChangeEvents(effectId, subject, input.collection, input.id, 'created');
		});
		const createMany = Effect.fn('Collections.createMany')(function* (effectId: EffectId, subject: Identity.Subject, inputs: ReadonlyArray<MutationInput>) {
			for (let index = 0; index < inputs.length; index += 1) {
				const input = inputs[index];
				if (input !== undefined) yield* create(EffectId.make(`${effectId}:${index}`), subject, input);
			}
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
			const result = yield* database.execute(effectId, { _tag: 'Query', sql: `select count(*) as count from ${quoteIdentifier(input.collection)} where (${compiled.sql}) and (${searched.sql}) and (${offsetParameters(visibility.sql, compiled.parameters.length + searched.parameters.length)})`, parameters: [...compiled.parameters, ...searched.parameters, ...visibility.parameters] });
			const row = result.rows[0];
			const value = typeof row === 'object' && row !== null ? Reflect.get(row, 'count') : undefined;
			return typeof value === 'number' ? value : Number(value ?? 0);
		});
		const update = Effect.fn('Collections.update')(function* (effectId, subject, input) {
			const definition = yield* workspace.collection(input.collection);
			yield* access.authorize(subject, 'update', input.collection);
			const visibility = access.predicate(subject, 'update', input.collection);
			if (requiresApproval(definition, visibility)) {
				return yield* holdForApproval(effectId, subject, input, 'update');
			}
			const module = authored.hooks[input.collection];
			const api = buildApi(effectId, subject);
			let values = input.values;
			if (module?.update?.input !== undefined) {
				values = yield* Schema.decodeUnknownEffect(module.update.input)(values).pipe(
					Effect.mapError((cause) => new AccessControl.AccessDenied({ action: 'update', resource: input.collection, reason: 'hook input validation failed' }))
				) as Effect.Effect<Readonly<Record<string, Schema.Json>>>;
			}
			// Read once and used twice where both want it. An outbound binding needs it because a
			// trigger is asked `previous.status !== record.status` and a patch alone cannot answer that;
			// the hook needs it because it always has. The read is skipped entirely when neither does,
			// so a collection with no `update` hook and no outbound binding costs nothing for it.
			const wantsPrevious = module?.update?.before !== undefined || needsPreviousRow(input.collection, 'update');
			const existing = wantsPrevious ? yield* readRowElevated(effectId, input.collection, input.id) : undefined;
			if (module?.update?.before !== undefined) {
				const before = yield* runHook<unknown>(module.update.before, { input: values, existing, api }, api);
				if (before !== null && before !== undefined && typeof before === 'object') {
					values = before as Readonly<Record<string, Schema.Json>>;
				}
			}
			yield* applyUpdate(effectId, subject, { ...input, values }, definition, false, false, existing);
			if (module?.update?.after !== undefined) {
				const afterApi = buildApi(effectId, subject, true);
				const record = yield* readRowElevated(effectId, input.collection, input.id);
				yield* runHook<unknown>(module.update.after, { record, api: afterApi }, afterApi);
			}
			yield* emitChangeEvents(effectId, subject, input.collection, input.id, 'updated');
		});
		const deleteRecord = Effect.fn('Collections.delete')(function* (effectId, subject, collection, id) {
			const definition = yield* workspace.collection(collection);
			yield* access.authorize(subject, 'delete', collection);
			const visibility = access.predicate(subject, 'delete', collection);
			if (requiresApproval(definition, visibility)) {
				return yield* holdForApproval(effectId, subject, { collection, id, values: {} }, 'delete');
			}
			const module = authored.hooks[collection];
			const api = buildApi(effectId, subject);
			let existing: Readonly<Record<string, unknown>> | undefined;
			if (module?.delete?.before !== undefined || needsPreviousRow(collection, 'delete')) {
				// An outbound delete binding needs this read for a reason no hook has: after the statement
				// runs there is no row left to describe, so a delivery that did not capture it first can
				// only say that *something* with this id is gone.
				existing = yield* readRowElevated(effectId, collection, id);
			}
			if (module?.delete?.before !== undefined) {
				yield* runHook<unknown>(module.delete.before, { existing, api }, api);
			}
			const record = module?.delete?.after !== undefined
				? (existing ?? (yield* readRowElevated(effectId, collection, id)))
				: undefined;
			yield* applyDelete(effectId, subject, collection, id, definition, false, existing);
			if (module?.delete?.after !== undefined) {
				const afterApi = buildApi(effectId, subject, true);
				yield* runHook<unknown>(module.delete.after, { record, api: afterApi }, afterApi);
			}
			yield* emitChangeEvents(effectId, subject, collection, id, 'deleted');
		});
		const resume = Effect.fn('Collections.resume')(function* (effectId: EffectId, requestId: string) {
			const state = yield* approvals.status(effectId, requestId);
			if (state === undefined) return yield* new ApprovalConflict({ requestId, reason: 'approval request was not found' });
			yield* approvals.authorizeResume(state);
			const stored = (() => {
				switch (state._tag) {
					case 'Approved':
						return state.operation;
					case 'Pending':
						return state.operation;
					case 'Rejected':
					case 'Withdrawn':
						return undefined;
					default: {
						const _exhaustive: never = state;
						return _exhaustive;
					}
				}
			})();
			if (stored === undefined || !Schema.is(JsonObject)(stored)) {
				return yield* new ApprovalConflict({ requestId, reason: 'stored approval operation is missing' });
			}
			const operation = yield* Schema.decodeUnknownEffect(CollectionOperation)({
				collection: stored.collection,
				id: stored.id,
				values: stored.values,
				action: stored.action,
				subject: stored.subject
			}).pipe(
				Effect.mapError(() => new ApprovalConflict({ requestId, reason: 'stored approval operation is malformed' }))
			);
			const definition = yield* workspace.collection(operation.collection);
			switch (operation.action) {
				case 'create':
					yield* applyCreate(effectId, operation.subject, operation, definition);
					return;
				case 'update':
					yield* applyUpdate(effectId, operation.subject, operation, definition, true);
					return;
				case 'delete':
					yield* applyDelete(effectId, operation.subject, operation.collection, operation.id, definition);
					return;
				default: {
					const _exhaustive: never = operation.action;
					return yield* new ApprovalConflict({ requestId, reason: `unsupported stored action ${_exhaustive}` });
				}
			}
		});
		return Service.of({
			findMany,
			findFirst: Effect.fn('Collections.findFirst')(function* (effectId, subject, input) {
				return (yield* findMany(effectId, subject, { ...input, limit: 1 }))[0];
			}),
			count,
			create,
			createMany,
			update,
			delete: deleteRecord,
			resume,
			import: Effect.fn('Collections.import')(function* (effectId, subject, inputs) {
				const pipeline = authored.pipelines[inputs[0]?.collection ?? ''];
				if (pipeline?.import !== undefined) {
					const api = buildApi(effectId, subject);
					const rows = yield* runAuthoredHandler(
						pipeline.import.handler({ input: inputs.map((entry) => entry.values), api }, api)
					);
					if (!Array.isArray(rows)) {
						return yield* new AccessControl.AccessDenied({ action: 'import', resource: inputs[0]?.collection ?? '', reason: 'import pipeline returned no rows' });
					}
					yield* createMany(
						effectId,
						subject,
						rows.map((row, index) => ({
							collection: inputs[index]?.collection ?? inputs[0]?.collection ?? '',
							id: typeof row === 'object' && row !== null && typeof Reflect.get(row, 'norbital_id') === 'string'
								? Reflect.get(row, 'norbital_id') as string
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
				const pipeline = authored.pipelines[input.collection];
				if (pipeline?.export !== undefined) {
					const api = buildApi(effectId, subject);
					const records = yield* findMany(effectId, subject, input);
					return yield* runAuthoredHandler(pipeline.export.handler({ records, api }, api));
				}
				return yield* findMany(effectId, subject, input);
			}) as Interface['export'],
			history: Effect.fn('Collections.history')(function* (effectId, subject, collection, id) {
				yield* workspace.collection(collection);
				yield* access.authorize(subject, 'history', collection);
				return (yield* database.execute(effectId, { _tag: 'Query', sql: 'select * from bolt_collection_history where collection_name = $1 and record_id = $2 order by sequence desc', parameters: [collection, id] })).rows;
			})
		});
	})
);

export * as Collections from './collections.js';
