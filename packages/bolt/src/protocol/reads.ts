// Bolt's reads beside the store's (`@norbital-ai/store`: read, get, aggregate, similar): history, a collection query,
// the transform's `after`, and the shell's agent and inbox reads; a declared (dynamic) read and a revision `get`; and
// the one decoder of a read call off the wire (D15).
import { Predicate, Result, Schema } from 'effect';
import {
	aggregate,
	collectionOf,
	exposedField,
	get as storeGet,
	read as storeRead,
	semantic,
	similar,
	where,
	type Catalog,
	type ListRead,
	type Pred,
	type ReadIR as StoreReadIR
} from '@norbital-ai/store';
import { BoltError, storeSync } from './errors.ts';
import type { Json } from '../decl/values.ts';

type Obj = { readonly [k: string]: unknown };
const invalid = (message: string) => BoltError.make('invalid', 'decode', message);

/** `{ instant } | { revision } | { before }` of `history` (rule 17). */
type HistoryAt =
	| { readonly _tag: 'Instant'; readonly instant: string }
	| { readonly _tag: 'Revision'; readonly revision: number }
	| { readonly _tag: 'Before'; readonly before: string };
/** Every read a crossing carries (wire discriminant `kind`, D15): the store's, and Bolt's own. */
export type ReadIR =
	| StoreReadIR
	| {
			readonly kind: 'history';
			readonly collection: string;
			readonly id: string;
			readonly at?: HistoryAt | undefined;
			readonly full?: true | undefined;
	  }
	/** A collection query: a guest invocation reading as its caller. */
	| {
			readonly kind: 'query';
			readonly collection: string;
			readonly query: string;
			readonly input: Json;
	  }
	/** The transform's `db.after`: stored rows overlaid with this batch. */
	| {
			readonly kind: 'after';
			readonly collection: string;
			readonly where: Pred;
			readonly query?: ListRead | undefined;
	  }
	/** The agent panel's messages of one conversation in `seq` order. */
	| {
			readonly kind: 'transcript';
			readonly collection: 'sys_message';
			readonly conversation: string;
			readonly thread: boolean;
			/** An automation run's inference transcript: read-only. */
			readonly automation?: true | undefined;
			readonly from?: number | undefined;
	  }
	/** The shell inbox: own notices, with an optional caller-filtered open request list. */
	| {
			readonly kind: 'inbox';
			readonly collection: 'sys_notification';
			readonly member: string;
			readonly requests?: true | undefined;
	  }
	/** The agent panel's conversation list: one member's own conversations, most recently active first. */
	| {
			readonly kind: 'conversations';
			readonly collection: 'sys_conversation';
			readonly member: string;
	  };

const DeclaredQuery = Schema.Struct({
	mode: Schema.Literal('declared'),
	where: Schema.optionalKey(Schema.UndefinedOr(Schema.Json)),
	select: Schema.optionalKey(Schema.UndefinedOr(Schema.Array(Schema.String))),
	all: Schema.Literal(true)
});
/** One checked dynamic shape for native guest reads, /q, and the test kit's native answer decoder. */
export function declaredQuery(
	cat: Catalog,
	collection: string,
	input: unknown,
	readAs: 'caller' | 'workspace'
): Obj {
	const decoded = Schema.decodeUnknownResult(DeclaredQuery, { onExcessProperty: 'error' })(input);
	if (Result.isFailure(decoded)) throw invalid(decoded.failure.message);
	const query = decoded.success;
	const info = storeSync(collectionOf(cat, collection));
	if (collection === 'sys_run') throw invalid(`'${collection}' is not readable`);
	for (const name of query.select ?? []) {
		const field = info.model.fields.get(name);
		// The catalog lowers a native sequence to derived int/text; other derived fields are roll-ups.
		const selectable =
			readAs === 'caller'
				? exposedField(info, name)
				: field !== undefined &&
					!field.computed &&
					(!field.derived || field.kind === 'int' || field.kind === 'text');
		if (field === undefined || name.includes('.') || !selectable)
			throw invalid(`cannot select '${name}' of '${collection}'`);
	}
	return {
		...(query.where === undefined ? {} : { where: query.where }),
		...(query.select === undefined
			? {}
			: {
					select: Object.fromEntries(
						['id', ...query.select].map((name): readonly [string, true] => [name, true])
					)
				}),
		all: true
	};
}

/** `read(collection, { where?, select?, orderBy?, search? } & Paged)`, or a declared read's checked shape. */
export function read(
	cat: Catalog,
	collection: string,
	q: Obj,
	readAs: 'caller' | 'workspace' = 'caller'
): ReadIR {
	return storeSync(
		storeRead(
			cat,
			collection,
			q.mode === 'declared' ? declaredQuery(cat, collection, q, readAs) : q
		)
	);
}
/** `get(collection, id, { select?, revision? })`; L-BOLT-181: a revision get is the history fold, not a table read. */
export function get(cat: Catalog, collection: string, id: string, q: Obj = {}): ReadIR {
	if (q.revision === undefined) return storeSync(storeGet(cat, collection, id, q));
	storeSync(collectionOf(cat, collection));
	// ponytail: `select` does not narrow a revision get
	if (!Number.isInteger(q.revision)) throw invalid('revision is an integer');
	return {
		kind: 'history',
		collection,
		id,
		at: { _tag: 'Revision', revision: q.revision as number },
		full: true
	};
}

/** The wire decoder retains each normalizer's exact message in its Result failure. */
class DecodeError extends Schema.TaggedError<DecodeError>()('DecodeError', {
	message: Schema.String,
	cause: Schema.optional(Schema.Defect())
}) {}
export const decode = <A>(read: () => A): Result.Result<A, DecodeError> =>
	Result.try({
		try: read,
		catch: (cause) =>
			new DecodeError({ message: cause instanceof Error ? cause.message : String(cause), cause })
	});
export function historyAt(at: unknown): NonNullable<Extract<ReadIR, { kind: 'history' }>['at']> {
	if (typeof at === 'string') return { _tag: 'Instant', instant: at };
	if (typeof at === 'number') return { _tag: 'Revision', revision: at };
	if (Predicate.isObject(at)) {
		if (typeof at.instant === 'string') return { _tag: 'Instant', instant: at.instant };
		if (typeof at.revision === 'number') return { _tag: 'Revision', revision: at.revision };
		if (typeof at.before === 'string') return { _tag: 'Before', before: at.before };
	}
	throw invalid('history takes { at: instant | revision | { before } }');
}
/** One boundary for read calls; helpers above normalize already-known parts of a read or grant. */
export function decodeRead(
	cat: Catalog,
	member: string,
	args: readonly Json[]
): Result.Result<ReadIR, DecodeError> {
	return decode(() => {
		const collection = String(args[0]),
			[, a, b, d] = args;
		const object = (value: Json | undefined): Obj => (Predicate.isObject(value) ? value : {});
		switch (member.replace(/^db\./, '')) {
			case 'read':
				if (
					Predicate.isObject(a) &&
					a.mode === 'declared' &&
					(args.length !== 2 || typeof args[0] !== 'string')
				)
					throw invalid('a declared read takes a collection name and one query');
				return read(cat, collection, object(a), member.startsWith('db.') ? 'workspace' : 'caller');
			case 'get':
				return get(cat, collection, String(a), object(b));
			case 'aggregate':
				return storeSync(aggregate(cat, collection, object(a)));
			case 'similar':
				return storeSync(
					a !== null && typeof a === 'object'
						? semantic(cat, collection, object(a))
						: similar(cat, collection, String(a), b ?? null, object(d))
				);
			case 'after': {
				const query =
					b === undefined ? undefined : read(cat, collection, { ...object(b), where: a });
				return {
					kind: 'after',
					collection,
					where: storeSync(where(cat, collection, a)),
					...(query?.kind === 'read' ? { query } : {})
				};
			}
			case 'history':
				return {
					kind: 'history',
					collection,
					id: String(a),
					...(b == null ? {} : { at: historyAt(b) })
				};
			case 'query':
				return { kind: 'query', collection, query: String(a), input: b ?? null };
			default:
				throw invalid(`'${member}' is not a read`);
		}
	});
}
