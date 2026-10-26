import assert from 'node:assert/strict';
import { afterEach } from '@effect/vitest';
import { Cause, Effect, Queue, Schema, Stream } from 'effect';
import type { Json } from '@norbital-ai/std/wire';
import type { Value } from '@norbital-ai/std/kind';
import type { ActBody, Outcome as WireOutcome } from '../../bolt/build/protocol/schema.js';
import type { RecordCapabilities, RecordParentContext } from '../src/record/types.ts';
import type { ViewBolt } from '../src/client/contract.ts';
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

export const ReadOptions = Schema.Struct({
	select: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
	where: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
	orderBy: Schema.optionalKey(Schema.Json),
	by: Schema.optionalKey(Schema.Json),
	limit: Schema.optionalKey(Schema.Number),
	after: Schema.optionalKey(Schema.String),
	search: Schema.optionalKey(Schema.Json),
	all: Schema.optionalKey(Schema.Boolean)
});
export type ReadOptions = typeof ReadOptions.Type;
export type ActOptions = { key: string; observed?: Readonly<Record<string, number>> };
export type ViewScript = {
	read(collection: string, options: ReadOptions): ReadReply;
	get(
		collection: string,
		id: string,
		select?: Readonly<Record<string, Json>>,
		options?: { revision?: number }
	): ReadReply;
	aggregate(collection: string, options: ReadOptions): ReadReply;
	history(collection: string, id: string): ReadReply;
	query(name: string, input: Json): ReadReply;
	act(
		callable: string,
		input: ActBody['input'],
		options: ActOptions
	): WireOutcome | Effect.Effect<WireOutcome, Error>;
	capabilities?: (
		collection: string,
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

export async function viewFixture(extra: Partial<ViewScript> = {}) {
	const script: ViewScript = {
		read: () => ({ rows: [], next: null }),
		get: () => null,
		aggregate: () => [],
		history: () => [],
		query: () => [],
		act: () => ({ kind: 'committed', output: null, records: [] }),
		...extra
	};
	const query = (target: Json | undefined, args: Json | undefined): ReadReply => {
		if (typeof target !== 'string') {
			const members = jsonRecord(target);
			return (async () => {
				const answers: Record<string, Value> = {};
				for (const [key, member] of Object.entries(members)) {
					const { from, ...input } = jsonRecord(member);
					const answer = await query(strings(from), input);
					if (answer instanceof Response) return answer;
					answers[key] = answer;
				}
				return answers;
			})();
		}
		if (target.includes('.')) return script.query(target, args ?? null);
		const input = jsonRecord(args ?? {});
		if (typeof input.id === 'string') {
			const details = Schema.decodeUnknownSync(
				Schema.Struct({
					select: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
					revision: Schema.optionalKey(Schema.Number)
				})
			)(input);
			return script.get(target, input.id, details.select, {
				...(details.revision === undefined ? {} : { revision: details.revision })
			});
		}
		return script.read(target, options(input));
	};
	const fixture = await scriptedBolt({
		answer: (read) => {
			const [target, arg] = read.a;
			switch (read.m) {
				case 'query':
					return query(target, arg);
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
			const collection = strings(params.get('collection')),
				id = strings(params.get('id'));
			const parent = params.has('parentCollection')
				? {
						collection: strings(params.get('parentCollection')),
						id: strings(params.get('parentId')),
						relation: strings(params.get('relation')),
						revision: Schema.decodeUnknownSync(Schema.NumberFromString)(
							params.get('parentRevision')
						)
					}
				: undefined;
			return script.capabilities?.(collection, id, parent) ?? null;
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
