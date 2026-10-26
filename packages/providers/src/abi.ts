// The driver ABI, the providers' side (D10b). A provider is written as Effects (`ProviderDef`); the engine is another
// module graph and calls it through the Promise + AbortSignal contract (`Provider`, `Link`, `DriverOpen`). `toDrivers`
// is the one adapter: every call runs on the host's runner, an aborted signal interrupts it, a refusal crosses as the
// engine's `SendRefused` and any other failure as itself; a link's resources live in its own scope, closed by `close`.
import { Context, Effect, Exit, FiberSet, Layer, Scope, Semaphore } from 'effect';
import {
	SendRefused,
	type DriverOpen,
	type DriverPage,
	type Json,
	type Link,
	type OutboundAttachment,
	type Provider
} from '@norbital-ai/bolt/engine';
import type { ProviderFailure } from './errors.ts';

/** The host's runner (`FiberSet.makeRuntimePromise`): runs an Effect to a Promise, interrupted when `signal` aborts. */
export type Run = <A, E>(
	effect: Effect.Effect<A, E>,
	options?: { readonly signal?: AbortSignal | undefined }
) => Promise<A>;

/** The ABI runner for SDK callbacks; its fibers belong to the opened link's scope. */
export class ProviderRuntime extends Context.Service<ProviderRuntime, Run>()('providers/Runtime') {}
/** Process-wide first-sync admission, shared by the providers a host constructs once. */
export class FirstSyncs extends Context.Service<FirstSyncs, Semaphore.Semaphore>()(
	'providers/FirstSyncs'
) {
	static readonly layer = Layer.effect(FirstSyncs, Semaphore.make(2));
}

/** One instance's live link as a provider writes it: whichever members its driver supports, each an Effect (called detached, never through `this`). */
export type LinkDef = {
	readonly close?: Effect.Effect<void> | undefined;
	readonly pair?: ((input: Json) => Effect.Effect<void, ProviderFailure>) | undefined;
	readonly unpair?: (() => Effect.Effect<void, ProviderFailure>) | undefined;
	readonly test?: ((input: Json) => Effect.Effect<void, ProviderFailure>) | undefined;
	readonly send?:
		| ((
				message: Json,
				attachments: readonly OutboundAttachment[] | undefined
		  ) => Effect.Effect<{ providerId: string; presumeAfterMs?: number }, ProviderFailure>)
		| undefined;
	readonly typing?: ((to: string) => Effect.Effect<void, ProviderFailure>) | undefined;
	readonly request?: ((op: Json) => Effect.Effect<Json, ProviderFailure>) | undefined;
	readonly read?:
		| ((
				sync: string,
				partition: string,
				cursor: Json | null
		  ) => Effect.Effect<DriverPage, ProviderFailure>)
		| undefined;
	readonly discover?:
		(() => Effect.Effect<readonly { id: string; label: string }[], ProviderFailure>) | undefined;
	readonly renew?: (() => Effect.Effect<string | null, ProviderFailure>) | undefined;
	readonly webhook?: ((request: Request) => Effect.Effect<Response, ProviderFailure>) | undefined;
};
/** A provider written as Effects: `open` acquires the link's resources in the scope `close` ends. */
export type ProviderDef = Omit<Provider, 'open'> & {
	readonly _tag: 'ProviderDef';
	readonly open: (
		ctx: DriverOpen
	) => Effect.Effect<LinkDef, ProviderFailure, Scope.Scope | ProviderRuntime | FirstSyncs>;
};

/** A failure as the engine reads a rejection: a refusal as its `SendRefused`, anything else as itself. */
const across = <A, R>(effect: Effect.Effect<A, ProviderFailure, R>) =>
	Effect.mapError(effect, (e) =>
		e._tag === 'ProviderRefused' ? new SendRefused(e.message, e.code, e.permanent) : e
	);

function link(def: LinkDef, scope: Scope.Closeable, run: Run): Link {
	const call = <A>(effect: Effect.Effect<A, ProviderFailure>, signal?: AbortSignal) =>
		run(across(effect), { signal });
	const out: Link = {
		close: () => run(Effect.ensuring(def.close ?? Effect.void, Scope.close(scope, Exit.void)))
	};
	const { pair, unpair, test, send, typing, request, read, discover, renew, webhook } = def;
	if (pair !== undefined) out.pair = (input) => call(pair(input));
	if (unpair !== undefined) out.unpair = () => call(unpair());
	if (test !== undefined) out.test = (input) => call(test(input));
	if (send !== undefined)
		out.send = (message, signal, attachments) => call(send(message, attachments), signal);
	if (typing !== undefined) out.typing = (to, signal) => call(typing(to), signal);
	if (request !== undefined) out.request = (op, signal) => call(request(op), signal);
	if (read !== undefined)
		out.read = (sync, partition, cursor, signal) => call(read(sync, partition, cursor), signal);
	if (discover !== undefined) out.discover = () => call(discover());
	if (renew !== undefined) out.renew = () => call(renew());
	if (webhook !== undefined) out.webhook = (r) => call(webhook(r));
	return out;
}

/** `def` as the engine's `Provider`: `open` builds the link in a fresh scope, closed when opening fails or the link closes. */
const promised = (
	{ _tag, open, ...choice }: ProviderDef,
	run: Run,
	firstSyncs: Semaphore.Semaphore
): Provider => ({
	...choice,
	open: (ctx) =>
		run(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				const callbackRun = yield* FiberSet.makeRuntimePromise<never>().pipe(Scope.provide(scope));
				const def = yield* across(open(ctx)).pipe(
					Effect.provideService(ProviderRuntime, callbackRun),
					Effect.provideService(FirstSyncs, firstSyncs),
					Scope.provide(scope),
					Effect.onError(() => Scope.close(scope, Exit.void))
				);
				return link(def, scope, run);
			}),
			{ signal: ctx.signal }
		)
});

/** The providers a host registers, as the engine calls them; `run` is the host's runner. */
export const toDrivers = (
	defs: readonly ProviderDef[],
	run: Run
): Effect.Effect<readonly Provider[]> =>
	Semaphore.make(2).pipe(Effect.map((firstSyncs) => defs.map((d) => promised(d, run, firstSyncs))));
