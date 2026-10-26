// The few helpers every provider shares: reading untrusted JSON, comparing secrets in constant time, outbound attachments.
import { timingSafeEqual } from 'node:crypto';
import { Effect, Option, Predicate, Schema } from 'effect';
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http';
import type { DriverOpen, Json, OutboundAttachment } from '@norbital-ai/bolt/engine';
import { Fenced } from '@norbital-ai/bolt/engine';
import { PairingInvalid, ProviderRefused, ProviderUnavailable } from './errors.ts';

export type Obj = { readonly [k: string]: Json };
export const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
/** Equal in constant time; an empty `want` never matches. */
export const same = (got: string, want: string): boolean => {
	const a = Buffer.from(got),
		b = Buffer.from(want);
	return want !== '' && a.length === b.length && timingSafeEqual(a, b);
};
/** Decode the instance's stored credential; a missing or obsolete shape requires pairing again. */
export const storedCredential = <A>(
	ctx: Pick<DriverOpen, 'credentials'>,
	schema: Schema.Decoder<A>,
	key = 'credential'
): Effect.Effect<Option.Option<A>, ProviderUnavailable> =>
	Effect.tryPromise({
		try: () => ctx.credentials.load(),
		catch: (e) =>
			new ProviderUnavailable({
				message: `the stored credentials could not be read: ${e instanceof Error ? e.message : 'the host refused'}`
			})
	}).pipe(Effect.map((stored) => Schema.decodeUnknownOption(schema)(stored.get(key))));
/** A setup field the operator must fill, or the refusal the shell shows verbatim. */
export const field = (
	input: Json,
	name: string,
	label: string,
	shape?: RegExp
): Effect.Effect<string, PairingInvalid> =>
	Effect.suspend(() => {
		const v = Predicate.isObject(input) ? input[name] : undefined;
		if (typeof v !== 'string' || v.trim() === '')
			return Effect.fail(new PairingInvalid({ message: `${label} is required` }));
		if (shape !== undefined && !shape.test(v.trim()))
			return Effect.fail(new PairingInvalid({ message: `${label} does not look right` }));
		return Effect.succeed(v.trim());
	});
/** An attachment bolt read for a send, as a multipart file part. */
export const blobOf = (a: OutboundAttachment): Blob =>
	new Blob([a.bytes.slice()], { type: a.mime });
/** A signed link to an attachment for a provider that fetches media itself; a host that serves none refuses the send for good. */
export const linkOf = (
	a: OutboundAttachment,
	expiresInS = 86_400
): Effect.Effect<string, ProviderRefused> =>
	Effect.tryPromise({
		try: () => a.url(expiresInS),
		catch: () =>
			new ProviderRefused({
				message: `${a.name}: this host serves no file link the provider can fetch`,
				permanent: true
			})
	});

const fence = Schema.decodeUnknownOption(Fenced);
/** The host's Promise callbacks are the driver ABI; an actual credential fence remains terminal. */
export const hostCall = <A>(
	operation: string,
	call: (signal: AbortSignal) => Promise<A>
): Effect.Effect<A, ProviderUnavailable | Fenced> =>
	Effect.tryPromise({
		try: call,
		catch: (error) => {
			const decoded = fence(error);
			return Option.isSome(decoded)
				? decoded.value
				: new ProviderUnavailable({
						message: `${operation}: ${error instanceof Error ? error.message : 'the host refused'}`
					});
		}
	});

/** The instance supplies its guarded fetch at the ABI; provider interiors use HttpClient. */
export const withFetch = <A, E, R>(
	ctx: Pick<DriverOpen, 'fetch'>,
	effect: Effect.Effect<A, E, R | HttpClient.HttpClient>
) =>
	effect.pipe(
		Effect.provide(FetchHttpClient.layer),
		Effect.provideService(FetchHttpClient.Fetch, ctx.fetch)
	);
