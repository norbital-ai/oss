import assert from 'node:assert/strict';
import { afterEach } from '@effect/vitest';
import { Cause, Effect, Queue, Schema, Stream } from 'effect';
import type { Json } from '@norbital-ai/std/wire';
import type { Value } from '@norbital-ai/std/kind';
import type { ActBody, Outcome as WireOutcome } from '../../bolt/build/protocol/schema.js';
import type { RecordCapabilities, RecordParentContext } from '../src/record/types.ts';
import type { ViewBolt } from '../src/client/contract.ts';
import { READ_LIMIT } from '../src/read/request.ts';
import { scriptedBolt, type ReadReply, type Script } from './scripted-bolt.ts';

export const required = <A>(value: A | null | undefined): A => {
	assert.ok(value !== null && value !== undefined);
	return value;
};
export const textOf = (node: Node | null | undefined): string => required(node).textContent ?? '';

class BrowserTestFailed extends Schema.TaggedError<BrowserTestFailed>()('BrowserTestFailed', {
	cause: Schema.Defect(),
	message: Schema.String
}) {}
export const fixtureEffect = <A>(work: () => A) =>
	Effect.try({
		try: work,
		catch: (cause) =>
			new BrowserTestFailed({
				cause,
				message: cause instanceof Error ? cause.message : String(cause)
			})
	});
export const browser = <A>(work: () => PromiseLike<A>) =>
	Effect.tryPromise({
		try: () => Promise.resolve(work()),
		catch: (cause) =>
			new BrowserTestFailed({
				cause,
				message: cause instanceof Error ? cause.message : String(cause)
			})
	});
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposals.splice(0).reverse()) await dispose();
});

/** One root's layer of a read request (or an aggregate's options), its sub-layers by path below the root (`lines.product`). */
export const ReadOptions = Schema.Struct({
	fields: Schema.optionalKey(Schema.Array(Schema.String)),
	layers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
	where: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
	orderBy: Schema.optionalKey(Schema.Json),
	by: Schema.optionalKey(Schema.Json),
	limit: Schema.optionalKey(Schema.Number),
	after: Schema.optionalKey(Schema.String),
	asOf: Schema.optionalKey(Schema.String),
	search: Schema.optionalKey(Schema.Json)
});
export type ReadOptions = typeof ReadOptions.Type;
/** A read of every matching row (select all, export): the read request's cap. */
export const everyRow = (options: ReadOptions) => options.limit === READ_LIMIT;
export type ActOptions = { key: string; observed?: Readonly<Record<string, number>> };
export type ViewScript = {
	read(model: string, options: ReadOptions): ReadReply;
	/** A read of one record by id (`where: { id: { eq } }`): its row or null, its sub-layers by path below the root. */
	get(
		model: string,
		id: string,
		layers?: Readonly<Record<string, Json>>,
		options?: { asOf?: string; fields?: readonly string[] }
	): ReadReply;
	aggregate(model: string, options: ReadOptions): ReadReply;
	history(model: string, id: string): ReadReply;
	act(
		callable: string,
		input: ActBody['input'],
		options: ActOptions
	): WireOutcome | Effect.Effect<WireOutcome, Error>;
	capabilities?: (
		model: string,
		id: string,
		parent?: RecordParentContext
	) => RecordCapabilities | null | Response | Promise<RecordCapabilities | null | Response>;
	approval?: Script['approval'];
	options?: NonNullable<ViewBolt['options']>;
	describe?: NonNullable<ViewBolt['describe']>;
	changes?: Script['changes'];
	start?: Script['start'];
	runs?: ViewBolt['runs'];
	t?: ViewBolt['t'];
	uuid?: () => string;
};
const strings = Schema.decodeUnknownSync(Schema.String);
const options = Schema.decodeUnknownSync(ReadOptions);
export const jsonRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));
export const jsonArray = Schema.decodeUnknownSync(Schema.Array(Schema.Json));

/** The record a root's `where` reads by id (`{ id: { eq } }`), if that is all it filters. */
const idOf = (where: Json | undefined): string | undefined => {
	const filter = where === undefined ? {} : jsonRecord(where);
	const id =
		Object.keys(filter).length === 1 && filter.id !== undefined ? jsonRecord(filter.id) : {};
	return Object.keys(id).length === 1 && typeof id.eq === 'string' ? id.eq : undefined;
};
/** The roots a wire read asks for one record of, by id. */
export const recordRootsOf = (read: { m: string; a: readonly Json[] }): readonly string[] =>
	read.m === 'query'
		? Object.entries(jsonRecord(read.a[0])).flatMap(([root, layer]) =>
				!root.includes('.') && idOf(jsonRecord(layer).where) !== undefined ? [root] : []
			)
		: [];
export async function viewFixture(extra: Partial<ViewScript> = {}) {
	const script: ViewScript = {
		read: () => ({ rows: [], next: null }),
		get: () => null,
		aggregate: () => [],
		history: () => [],
		act: () => ({ kind: 'committed', output: null, records: [] }),
		...extra
	};
	// a read request: each root is a `read` (a page) or, by id, a `get` (its row), with its sub-layers beside it
	const query = async (request: Json | undefined): Promise<Value | Response> => {
		const paths = jsonRecord(request ?? {});
		const answer: Record<string, Value> = {};
		for (const [root, layer] of Object.entries(paths)) {
			if (root.includes('.')) continue;
			const below = Object.entries(paths).flatMap(([path, l]) =>
				path.startsWith(`${root}.`) ? [[path.slice(root.length + 1), l] as const] : []
			);
			const layers = below.length === 0 ? undefined : Object.fromEntries(below);
			const input = options({ ...jsonRecord(layer), ...(layers === undefined ? {} : { layers }) });
			const id = idOf(input.where);
			if (id === undefined) {
				const page = await script.read(root, input);
				if (page instanceof Response) return page;
				answer[root] = page;
				continue;
			}
			const row = await script.get(root, id, layers, {
				...(input.asOf === undefined ? {} : { asOf: input.asOf }),
				...(input.fields === undefined ? {} : { fields: input.fields })
			});
			if (row instanceof Response) return row;
			answer[root] = { rows: row === null ? [] : [row], next: null };
		}
		return answer;
	};
	const fixture = await scriptedBolt({
		answer: (read) => {
			const [target, arg] = read.a;
			switch (read.m) {
				case 'query':
					return query(target);
				case 'aggregate':
					return script.aggregate(strings(target), options(arg));
				case 'history':
					return script.history(strings(target), strings(arg));
				default:
					throw new Error(`Unexpected ${read.m} in view fixture`);
			}
		},
		act: (body, key) =>
			script.act(body.callable, body.input, {
				key,
				...(body.observed === undefined ? {} : { observed: body.observed })
			}),
		capabilities: (params: URLSearchParams) => {
			const model = strings(params.get('model')),
				id = strings(params.get('id'));
			const parent = params.has('parentModel')
				? {
						model: strings(params.get('parentModel')),
						id: strings(params.get('parentId')),
						relation: strings(params.get('relation')),
						revision: Schema.decodeUnknownSync(Schema.NumberFromString)(
							params.get('parentRevision')
						)
					}
				: undefined;
			return script.capabilities?.(model, id, parent) ?? null;
		},
		...(script.approval === undefined
			? {}
			: { approval: (params) => script.approval?.(params) ?? null }),
		changes: (read, emit) => script.changes?.(read, emit) ?? (() => {}),
		...(script.start === undefined ? {} : { start: script.start }),
		...(script.runs === undefined ? {} : { runs: script.runs }),
		...(script.t === undefined ? {} : { t: script.t }),
		...(script.uuid === undefined ? {} : { uuid: script.uuid })
	});
	disposals.push(fixture.dispose);
	const { recordCapabilities: _capabilities, ...core } = fixture.bolt;
	const bolt: ViewBolt = {
		...core,
		...(script.capabilities === undefined
			? {}
			: { recordCapabilities: fixture.client.recordCapabilities }),
		...(script.options === undefined ? {} : { options: script.options }),
		...(script.describe === undefined ? {} : { describe: script.describe })
	};
	return {
		...fixture,
		bolt,
		script,
		setCapabilities: (capabilities: NonNullable<ViewScript['capabilities']>) => {
			script.capabilities = capabilities;
			bolt.recordCapabilities = fixture.client.recordCapabilities;
		}
	};
}

/** A scoped, pushable native Stream for component lifecycle scenarios. */
export function streamSource<A, E = never>() {
	const listeners = new Set<(value: A) => void>(),
		failures = new Set<(error: E) => void>();
	const stream = Stream.callback<A, E>((queue) =>
		Effect.gen(function* () {
			const emit = (value: A) => {
				Queue.offerUnsafe(queue, value);
			};
			const fail = (error: E) => {
				Queue.failCauseUnsafe(queue, Cause.fail(error));
			};
			listeners.add(emit);
			failures.add(fail);
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					listeners.delete(emit);
					failures.delete(fail);
				})
			);
		})
	);
	return {
		stream,
		listeners,
		emit: (value: A) => {
			for (const notify of listeners) notify(value);
		},
		fail: (error: E) => {
			for (const notify of failures) notify(error);
		}
	};
}
