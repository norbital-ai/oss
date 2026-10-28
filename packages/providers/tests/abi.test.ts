// Provider Effects cross the engine's sole Promise ABI: cancellation interrupts the admitted call, refusals retain
// their engine shape, and each link's owned resources close on link close or a failed opening.
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, FiberSet, Schema } from 'effect';
import type { DriverOpen, Json } from '@norbital-ai/bolt/engine';
import { toDrivers, type ProviderDef, type Run } from '../src/abi.ts';
import { PairingInvalid, ProviderRefused, ProviderUnavailable } from '../src/errors.ts';
import { fakeFetch, HOOK, REDIRECT } from './kit.ts';

class AbiRejected extends Schema.TaggedError<AbiRejected>()('AbiRejected', {
	cause: Schema.Defect()
}) {}
const abi = <A>(call: () => Promise<A>) =>
	Effect.tryPromise({ try: call, catch: (cause) => new AbiRejected({ cause }) });
const context = (): DriverOpen => ({
	instance: 'desk',
	definition: { description: 'Desk', driver: 'email' },
	syncs: [],
	configuration: {},
	personal: false,
	webhookUrl: HOOK,
	redirectUrl: REDIRECT,
	state: async () => `${crypto.randomUUID()}.desk`,
	signal: new AbortController().signal,
	fetch: fakeFetch([]),
	oauthClient: async () => undefined,
	credentials: { load: async () => new Map<string, Json>(), write: async () => {} },
	emit: async () => {},
	status: async () => {},
	pairing: () => {}
});

describe('toDrivers', () => {
	it.effect(
		'runs a link on the host runner, and an aborted signal interrupts its call (interrupt on abort)',
		() =>
			Effect.gen(function* () {
				const run: Run = yield* FiberSet.makeRuntimePromise();
				const started = yield* Deferred.make<void>(),
					interrupted = yield* Deferred.make<void>();
				let closed = false;
				const def: ProviderDef = {
					_tag: 'ProviderDef',
					id: 'fake',
					label: { en: 'Fake', zh: 'Fake' },
					setup: { kind: 'none', steps: [] },
					driver: 'email',
					open: () =>
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() =>
								Effect.sync(() => {
									closed = true;
								})
							);
							return {
								send: (message: Json) =>
									Effect.succeed({ providerId: `sent:${JSON.stringify(message)}` }),
								request: () =>
									Deferred.succeed(started, undefined).pipe(
										Effect.andThen(Effect.never),
										Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
									),
								pair: () => Effect.fail(new PairingInvalid({ message: 'a key is required' })),
								test: () =>
									Effect.fail(
										new ProviderRefused({
											message: 'not on WhatsApp',
											code: '63003',
											permanent: true
										})
									)
							};
						})
				};
				const [provider] = yield* toDrivers([def], run);
				if (provider === undefined) throw new Error('The native provider was not adapted.');
				const link = yield* abi(() => provider.open(context()));
				if (
					link.send === undefined ||
					link.request === undefined ||
					link.pair === undefined ||
					link.test === undefined
				)
					throw new Error('The adapted link lost a declared capability.');
				const { send, request, pair, test } = link;
				expect(yield* abi(() => send({ to: 'x' }, new AbortController().signal))).toEqual({
					providerId: 'sent:{"to":"x"}'
				});
				expect(link.typing).toBeUndefined();
				const abort = new AbortController();
				const pending = yield* abi(() => request({}, abort.signal)).pipe(
					Effect.exit,
					Effect.forkScoped
				);
				yield* Deferred.await(started);
				abort.abort();
				yield* Deferred.await(interrupted);
				expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true);
				expect((yield* abi(() => pair({})).pipe(Effect.flip)).cause).toMatchObject({
					name: 'PairingInvalid',
					message: 'a key is required'
				});
				expect((yield* abi(() => test({})).pipe(Effect.flip)).cause).toMatchObject({
					name: 'SendRefused',
					message: 'not on WhatsApp',
					code: '63003',
					permanent: true
				});
				expect(closed).toBe(false);
				yield* abi(() => link.close());
				expect(closed).toBe(true);
			})
	);

	it.effect('a failed provider opening releases every resource already acquired', () =>
		Effect.gen(function* () {
			const run: Run = yield* FiberSet.makeRuntimePromise();
			let acquired = 0,
				released = 0;
			const failure = new ProviderUnavailable({ message: 'SDK refused after acquisition' });
			const def: ProviderDef = {
				_tag: 'ProviderDef',
				id: 'failing',
				label: { en: 'Failing', zh: 'Failing' },
				setup: { kind: 'none', steps: [] },
				driver: 'email',
				open: () =>
					Effect.gen(function* () {
						yield* Effect.acquireRelease(
							Effect.sync(() => {
								acquired++;
							}),
							() =>
								Effect.sync(() => {
									released++;
								})
						);
						return yield* Effect.fail(failure);
					})
			};
			const [provider] = yield* toDrivers([def], run);
			if (provider === undefined) throw new Error('The native provider was not adapted.');
			expect((yield* abi(() => provider.open(context())).pipe(Effect.flip)).cause).toBe(failure);
			expect([acquired, released]).toEqual([1, 1]);
		})
	);
});
