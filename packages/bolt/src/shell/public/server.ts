import { Effect, Schema } from 'effect';
import { Instant, PlainDate } from '@norbital-ai/std/date';
import { encodeWire, type Wired } from '@norbital-ai/std/wire';
import { localOf } from '@norbital-ai/std/zone';
import type { Query } from '../../page/page-bolt.ts';
import { readValue } from '../../page/read-value.ts';
import { publicReadKey, type PublicBoot } from '../../protocol/public-page.ts';
import type { WireRead } from '../../protocol/wire.ts';
import type { Json } from '../../decl/values.ts';
import type { PublicClient } from './client.ts';
import { publicContext } from './context.ts';

const unavailable = (): never => {
	throw new Error('Start interactive page effects on mount.');
};

type PublicRead = WireRead & { readonly m: 'query' | 'aggregate' | 'history' };
type Lookup = (read: PublicRead) => Json | undefined;

const pageRead = <T>(lookup: Lookup, method: PublicRead['m'], args: readonly Wired[]): Query<T> => {
	const read = { m: method, a: args.map(encodeWire) };
	const state = {
		read,
		then: <A = T, B = never>(
			success?: ((value: T) => A | PromiseLike<A>) | null,
			failure?: ((reason: unknown) => B | PromiseLike<B>) | null
		) =>
			Promise.reject<T>(new Error('Use query state during server rendering.')).then(
				success,
				failure
			),
		get current() {
			const value = lookup(read);
			return value === undefined ? undefined : readValue<T>(value);
		},
		get loading() {
			return lookup(read) === undefined;
		},
		get error() {
			lookup(read);
			return undefined;
		}
	};
	const effect = Object.assign(
		Effect.suspend(() => Effect.never),
		{ read, then: state.then }
	);
	const query: Query<T> = Object.assign(effect, {
		current: undefined,
		error: undefined,
		loading: true
	});
	return Object.defineProperties(query, Object.getOwnPropertyDescriptors(state));
};

const publicServerContext = (boot: PublicBoot, now: string, lookup: Lookup): PublicClient => ({
	...publicContext(boot),
	aggregate: <T>(model: string, options: Wired) =>
		pageRead<T>(lookup, 'aggregate', [model, options]),
	history: <T>(model: string, id: string, options = {}) =>
		pageRead<T>(lookup, 'history', [model, id, options]),
	query: <T>(request: Readonly<Record<string, Wired>>) => pageRead<T>(lookup, 'query', [request]),
	clock: () => ({
		now: Instant(now),
		today: PlainDate(localOf(Date.parse(now), boot.workspace.tz).date)
	}),
	preview_pdf: unavailable,
	record_capabilities: unavailable,
	act: unavailable,
	run: unavailable,
	decode: unavailable,
	describe: unavailable,
	options: unavailable,
	upload: unavailable,
	approvals: { decide: unavailable, get: unavailable, list: unavailable },
	restore: { preview: unavailable, run: unavailable },
	session: { sendCode: unavailable, verify: unavailable },
	actor: boot.actor,
	locale: boot.workspace.locale,
	t: (key, vars = {}) =>
		(boot.messages[key] ?? key).replace(/\{([^{}]+)\}/g, (whole, name: string) =>
			String(vars[name] ?? whole)
		)
});

const encodeAnswer = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

/** Re-render after each batch of newly used reads. The guest bridge admits and meters every read. */
export const renderPublicPage = Effect.fnUntraced(function* <E>(
	boot: PublicBoot,
	now: string,
	read: (request: PublicRead) => Effect.Effect<unknown, E>,
	render: (ctx: PublicClient) => { body: string; head: string }
) {
	const reads = new Map<string, Json>();
	for (;;) {
		const pending = new Map<string, PublicRead>();
		const { body, head } = render(
			publicServerContext(boot, now, (request) => {
				const key = publicReadKey(request);
				const value = reads.get(key);
				if (value === undefined) pending.set(key, request);
				return value;
			})
		);
		if (pending.size === 0) return { body, head, reads: Object.fromEntries(reads) };
		yield* Effect.forEach(
			pending,
			([key, request]) =>
				read(request).pipe(
					Effect.flatMap((value) => encodeAnswer(JSON.stringify(value))),
					Effect.map((encoded) => reads.set(key, encoded))
				),
			{ concurrency: 'unbounded', discard: true }
		);
	}
});
