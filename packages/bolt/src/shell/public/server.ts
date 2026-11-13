import { DateTime, Effect, Result, Schema } from 'effect';
import type { Query } from '../../page/page-bolt.ts';
import { page_reads, readValue } from '../../page/read-value.ts';
import { view_client } from '../../page/view-client.ts';
import { read_wire } from '../../protocol/read-answer.ts';
import { ReadFailed } from '../../decl/errors.ts';
import { message_text } from '../../decl/errors/refusal.ts';
import { public_read_key, type PublicBoot } from '../../protocol/public-page.ts';
import type { WireRead } from '../../protocol/wire.ts';
import type { Json } from '../../decl/values.ts';
import type { PublicClient } from './client.ts';
import { public_context, public_ui } from './context.ts';

const unavailable = (): never => {
	throw new Error('Start interactive page effects on mount.');
};

type PublicRead = WireRead & { readonly m: 'query' | 'aggregate' | 'history' };
type Lookup = (read: PublicRead) => Json | undefined;

const pageRead = <A>(lookup: Lookup, method: PublicRead['m'], args: readonly Json[], schema: () => Schema.Decoder<A>): Query<A> => {
	const read = { m: method, a: args.map(read_wire) };
	let prepared: Schema.Decoder<A> | undefined;
	const decoder = () => prepared ?? (prepared = schema());
	const state = {
		read,
		then: <T = A, B = never>(
			success?: ((value: A) => T | PromiseLike<T>) | null,
			failure?: ((reason: unknown) => B | PromiseLike<B>) | null
		) =>
			Promise.reject<A>(new Error('Use query state during server rendering.')).then(
				success,
				failure
			),
		get current() {
			const value = lookup(read);
			if (value === undefined) return undefined;
			const decoded = readValue(decoder, value);
			return Result.isSuccess(decoded) ? decoded.success : undefined;
		},
		get loading() {
			return lookup(read) === undefined;
		},
		get error() {
			const value = lookup(read);
			if (value === undefined) return undefined;
			const decoded = readValue(decoder, value);
			return Result.isFailure(decoded) ? decoded.failure : undefined;
		}
	};
	const effect = Object.assign(
		Effect.suspend(() => Effect.never),
		{ read, then: state.then }
	);
	const query: Query<A> = Object.assign(effect, {
		current: undefined,
		error: undefined,
		loading: true
	});
	return Object.defineProperties(query, Object.getOwnPropertyDescriptors(state));
};

const publicServerContext = (boot: PublicBoot, now: string, lookup: Lookup) => {
	const page: Omit<PublicClient, 'ui'> = {
		...public_context(boot),
		...page_reads(boot.read_catalog, (method, args, schema) => pageRead(lookup, method, args, schema)),
		refresh: unavailable,
		clock: () => ({
			now,
			today: DateTime.formatIsoDate(DateTime.makeZonedUnsafe(now, { timeZone: boot.workspace.tz }))
		}),
		preview_pdf: unavailable,
		record_capabilities: unavailable,
		delete_verdict: unavailable,
		act: unavailable,
		run: unavailable,
		sync_control: unavailable,
		decode: unavailable,
		describe: unavailable,
		options: unavailable,
		upload: unavailable,
		approvals: { decide: unavailable, get: unavailable, list: unavailable },
		restore: { preview: unavailable, run: unavailable },
		session: { send_code: unavailable, verify: unavailable },
		actor: boot.actor,
		locale: boot.workspace.locale,
		t: (key, vars) => message_text(boot.messages, key, vars)
	};
	const views = view_client({ ...page, native_query: <A>(read: WireRead, schema: Schema.Decoder<A>) => {
		if (read.m !== 'query' && read.m !== 'aggregate' && read.m !== 'history')
			throw new ReadFailed({ code: 'protocol', message: 'This read is unavailable on a public page.' });
		return pageRead(lookup, read.m, read.a, () => schema);
	} }, boot.read_catalog, boot.catalog);
	const ctx: PublicClient = { ...page, ui: public_ui(boot, page, views) };
	return ctx;
};

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
		const context = publicServerContext(boot, now, (request) => {
			const key = public_read_key(request);
			const value = reads.get(key);
			if (value === undefined) pending.set(key, request);
			return value;
		});
		const { body, head } = render(context);
		if (pending.size === 0) return { body, head, reads: Object.fromEntries(reads) };
		yield* Effect.forEach(
			pending,
			([key, request]) =>
				read(request).pipe(
					Effect.flatMap((value) => Effect.try({
						try: () => read_wire(value),
						catch: (error) => error instanceof ReadFailed ? error : new ReadFailed({ code: 'protocol', message: 'The public page returned an invalid read value.' })
					})),
					Effect.map((encoded) => reads.set(key, encoded))
				),
			{ concurrency: 'unbounded', discard: true }
		);
	}
});
