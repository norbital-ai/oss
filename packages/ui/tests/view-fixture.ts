import assert from 'node:assert/strict';
import { afterEach } from '@effect/vitest';
import { Cause, Effect, Queue, Schema, Stream } from 'effect';
import type { Json } from '@norbital-ai/store';
import type { Value } from '@norbital-ai/store/kind';
import type { ActBody, Outcome as WireOutcome } from '../../bolt/build/protocol/schema.js';
import type { RecordCapabilities, RecordParentContext } from '../src/record/types.ts';
import type { ViewBolt } from '../src/client/contract.ts';
import { READ_LIMIT } from '../src/read/request.ts';
import { committed } from './act-envelope.ts';
import { read_catalog_of, scriptedBolt, type ReadReply, type Script } from './scripted-bolt.ts';

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
	output: Schema.optionalKey(Schema.String),
	fields: Schema.optionalKey(Schema.Array(Schema.String)),
	layers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
	where: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
	order_by: Schema.optionalKey(Schema.Json),
	by: Schema.optionalKey(Schema.Json),
	count: Schema.optionalKey(Schema.Boolean),
	sum: Schema.optionalKey(Schema.Array(Schema.String)),
	avg: Schema.optionalKey(Schema.Array(Schema.String)),
	min: Schema.optionalKey(Schema.Array(Schema.String)),
	max: Schema.optionalKey(Schema.Array(Schema.String)),
	limit: Schema.optionalKey(Schema.Number),
	after: Schema.optionalKey(Schema.String),
	as_of: Schema.optionalKey(Schema.String),
	search: Schema.optionalKey(Schema.Json),
	aggregate: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
});
export type ReadOptions = typeof ReadOptions.Type;
/** A read of every matching row (select all, export): the read request's cap. */
export const everyRow = (options: ReadOptions) => options.limit === READ_LIMIT;
export type ViewScript = {
	read(model: string, options: ReadOptions): ReadReply;
	/** A read of one record by id (`where: { id: { eq } }`): its row or null, its sub-layers by path below the root. */
	get(
		model: string,
		id: string,
		layers?: Readonly<Record<string, Json>>,
		options?: { as_of?: string; fields?: readonly string[] }
	): ReadReply;
	aggregate(model: string, options: ReadOptions): ReadReply;
	history(model: string, id: string, options?: Readonly<Record<string, Json>>): ReadReply;
	act(body: ActBody, key: string): WireOutcome | Effect.Effect<WireOutcome, Error>;
	sync_control?: Script['sync_control'];
	operation_outputs?: Script['operation_outputs'];
	read_catalog?: Script['read_catalog'];
	catalog?: Script['catalog'];
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
		read: () => ({ rows: [], next: null, total: 0 }),
		get: () => null,
		aggregate: (_model, options) => (options.by === undefined ? null : { rows: [], next: null }),
		history: () => [],
		act: committed,
		...extra
	};
	const read_catalog = script.read_catalog ?? read_catalog_of(script.catalog ?? {});
	type Output = NonNullable<typeof read_catalog[string][string]>;
	const plain = (value: Value | undefined): value is Readonly<Record<string, Value>> =>
		value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
	/** The host answers exactly a node's requested fields (absent values as null, refs as ids), its row state and its nested layers. */
	const project = (output: Output, path: string, node: Json, row: Value): Value => {
		const level = output[path];
		if (level === undefined || !plain(row)) return row;
		const request = jsonRecord(node);
		const named = Array.isArray(request.fields) ? request.fields.filter((field) => typeof field === 'string') : undefined;
		const out: Record<string, Value> = {};
		for (const field of new Set(['id', ...(named ?? Object.keys(level.fields))])) {
			const value = row[field] ?? null;
			// a single-target ref read as a field (not a layer) answers its target's id
			const kind = level.fields[field];
			out[field] = kind?.kind === 'ref' && typeof kind.to === 'string' && plain(value) && typeof value.id === 'string'
				? value.id : value;
		}
		for (const [key, value] of Object.entries(row)) if (key.startsWith('$')) out[key] = value;
		for (const [key, child] of Object.entries(request)) {
			if (queryOptions.has(key)) continue;
			const value = row[key] ?? null;
			out[key] = jsonRecord(child).aggregate !== undefined ? value
				: Array.isArray(value) ? value.map((item) => project(output, `${path}.${key}`, child, item))
				: value === null ? null : project(output, `${path}.${key}`, child, value);
		}
		return out;
	};
	/** A search page has no total; any other page counts its rows when the script names none. */
	const projectPage = (output: Output | undefined, root: string, node: Json, page: Value): Value => {
		if (output === undefined || !plain(page) || !Array.isArray(page.rows)) return page;
		const { total, ...rest } = page, search = plain(jsonRecord(node).search ?? null);
		const rows = page.rows.map((row) => project(output, root, node, row));
		return search ? { ...rest, rows } : { ...rest, rows, total: total ?? rows.length };
	};
	const queryOptions = new Set(['output', 'where', 'fields', 'order_by', 'limit', 'after', 'as_of', 'search', 'aggregate']);
	// Native requests nest each relation under its root. Only this assertion helper projects their paths into `layers`.
	const query = async (request: Json | undefined): Promise<Value | Response> => {
		const paths = jsonRecord(request ?? {});
		const answer: Record<string, Value> = {};
		for (const [root, layer] of Object.entries(paths)) {
			if (root.includes('.')) throw new Error('A read fixture requires nested root requests.');
			const layers: Record<string, Json> = {};
			const own = (node: Json): Record<string, Json> => Object.fromEntries(
				Object.entries(jsonRecord(node)).filter(([key]) => queryOptions.has(key))
			);
			const visit = (node: Json, prefix: string) => {
				for (const [key, child] of Object.entries(jsonRecord(node))) {
					if (queryOptions.has(key)) continue;
					const path = prefix === '' ? key : `${prefix}.${key}`;
					layers[path] = own(child);
					visit(child, path);
				}
			};
			visit(layer, '');
			const nested = Object.keys(layers).length === 0 ? undefined : layers;
			const input = options({ ...own(layer), ...(nested === undefined ? {} : { layers: nested }) });
			if (input.aggregate !== undefined) {
				const result = await script.aggregate(root, options({ ...input, ...input.aggregate }));
				if (result instanceof Response) return result;
				answer[root] = result;
				continue;
			}
			const output = read_catalog[root]?.[input.output ?? 'default'];
			const id = idOf(input.where);
			if (id === undefined) {
				const page = await script.read(root, input);
				if (page instanceof Response) return page;
				answer[root] = projectPage(output, root, layer, page);
				continue;
			}
			const row = await script.get(root, id, nested, {
				...(input.as_of === undefined ? {} : { as_of: input.as_of }),
				...(input.fields === undefined ? {} : { fields: input.fields })
			});
			if (row instanceof Response) return row;
			answer[root] = projectPage(output, root, layer, { rows: row === null ? [] : [row], next: null, total: row === null ? 0 : 1 });
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
					return script.history(strings(target), strings(arg), jsonRecord(read.a[2] ?? {}));
				default:
					throw new Error(`Unexpected ${read.m} in view fixture`);
			}
		},
		act: (body, key) => script.act(body, key),
		capabilities: (params: URLSearchParams) => {
			const model = strings(params.get('model')),
				id = strings(params.get('id'));
			const parent = params.has('parent_model')
				? {
						model: strings(params.get('parent_model')),
						id: strings(params.get('parent_id')),
						relation: strings(params.get('relation')),
						revision: Schema.decodeUnknownSync(Schema.NumberFromString)(
								params.get('parent_revision')
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
		...(script.sync_control === undefined ? {} : { sync_control: script.sync_control }),
		...(script.operation_outputs === undefined ? {} : { operation_outputs: script.operation_outputs }),
		read_catalog,
		...(script.catalog === undefined ? {} : { catalog: script.catalog }),
		...(script.runs === undefined ? {} : { runs: script.runs }),
		...(script.t === undefined ? {} : { t: script.t }),
		...(script.uuid === undefined ? {} : { uuid: script.uuid })
	});
	disposals.push(fixture.dispose);
	const { record_capabilities: _capabilities, ...core } = fixture.bolt;
	const bolt: ViewBolt = {
		...core,
		...(script.capabilities === undefined
			? {}
			: { record_capabilities: fixture.client.record_capabilities }),
		...(script.options === undefined ? {} : { options: script.options }),
		...(script.describe === undefined ? {} : { describe: script.describe })
	};
	return {
		...fixture,
		bolt,
		script,
		setCapabilities: (capabilities: NonNullable<ViewScript['capabilities']>) => {
			script.capabilities = capabilities;
			bolt.record_capabilities = fixture.client.record_capabilities;
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
