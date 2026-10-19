// The driver ABI, the engine's side (D10b): a provider's Promise link as Effects. Interrupting a call aborts the
// provider's signal, an answer is decoded, a send's refusal is the engine's `SendRefused` (from any module graph, by
// name), a member the provider lacks is `Unavailable`, and closing the link's scope closes it and aborts its signal.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, FiberSet, Scope, Exit } from 'effect';
import { FacilityFailure, Unavailable } from '../src/decl/errors.ts';
import { SendRefused } from '../src/engine/conversations/status.ts';
import { linkCalls, openLink } from '../src/engine/integrations/abi.ts';
import type { DriverOpen, Link, Provider } from '../src/engine/integrations/driver.ts';
import type { Json } from '../src/decl/values.ts';

describe('the driver ABI, engine side', () => {
	it.effect('interrupting a call aborts the signal the provider was given', () =>
		Effect.gen(function* () {
			let aborted = false,
				started = false;
			const link: Link = {
				close: async () => {},
				request: (_op, signal) =>
					new Promise(() => {
						started = true;
						signal.addEventListener('abort', () => {
							aborted = true;
						});
					})
			};
			const run = yield* FiberSet.makeRuntimePromise<never>();
			const fiber = yield* Effect.forkChild(
				linkCalls(link, run, 'test').request({ method: 'GET' })
			);
			yield* Effect.yieldNow;
			expect(started).toBe(true);
			yield* Fiber.interrupt(fiber);
			expect(aborted).toBe(true);
		})
	);

	it.effect(
		'decodes answers, classifies a send refusal by name, and fails an absent member as Unavailable',
		() =>
			Effect.gen(function* () {
				// a `SendRefused` from another module graph: an Error named so, with its code and permanence
				const foreign = Object.assign(new Error('the number is not on WhatsApp'), {
					name: 'SendRefused',
					code: '63003',
					permanent: true
				});
				let sent = 0;
				const link: Link = {
					close: async () => {},
					send: async () => {
						sent++;
						if (sent === 1) return { providerId: 'p1', presumeAfterMs: 60_000 };
						throw foreign;
					},
					renew: async () => '2026-10-15T00:00:00.000Z',
					read: async () => ({ items: [{ id: 'e1' }], cursor: 'c2', more: false })
				};
				const run = yield* FiberSet.makeRuntimePromise<never>();
				const calls = linkCalls(link, run, 'test');
				expect(yield* calls.send({ to: '+65', text: 'hi' })).toEqual({
					providerId: 'p1',
					presumeAfterMs: 60_000
				});
				const refused = yield* Effect.flip(calls.send({ to: '+65', text: 'hi' }));
				expect(refused).toBeInstanceOf(SendRefused);
				expect(refused).toMatchObject({
					message: 'the number is not on WhatsApp',
					code: '63003',
					permanent: true
				});
				// A foreign JavaScript provider can violate the ABI despite this graph's typed interface.
				Object.defineProperty(link, 'send', { value: async () => ({ providerId: 7 }) });
				expect(
					yield* Effect.flip(linkCalls(link, run, 'test').send({ to: '+65', text: 'hi' }))
				).toMatchObject({ _tag: 'FacilityFailure', kind: 'upstream' });
				expect(yield* calls.renew).toBe('2026-10-15T00:00:00.000Z');
				expect(yield* calls.read('events', 'all', null)).toEqual({
					items: [{ id: 'e1' }],
					cursor: 'c2',
					more: false
				});
				const absent = yield* Effect.flip(calls.typing('+65'));
				expect(absent).toBeInstanceOf(Unavailable);
				expect(absent).toMatchObject({ facility: 'link.typing' });
				expect(yield* Effect.flip(calls.discover)).toBeInstanceOf(Unavailable);
			})
	);

	it.effect('a provider whose answer is not its result is upstream', () =>
		Effect.gen(function* () {
			const link: Link = { close: async () => {} };
			Object.defineProperty(link, 'discover', { value: async () => [{ id: 1 }] });
			const run = yield* FiberSet.makeRuntimePromise<never>();
			const e = yield* Effect.flip(linkCalls(link, run, 'test').discover);
			expect(e).toBeInstanceOf(FacilityFailure);
			expect(e).toMatchObject({
				kind: 'upstream',
				message: 'link answered something that is not its result'
			});
		})
	);

	it.effect('openLink hands the scope its signal, and closing the scope closes the link', () =>
		Effect.gen(function* () {
			let closed = false,
				signal: AbortSignal | undefined;
			const provider: Provider = {
				id: 'p',
				label: 'P',
				setup: { kind: 'none', steps: [] },
				driver: 'email',
				open: async (ctx) => {
					signal = ctx.signal;
					return {
						close: async () => {
							closed = true;
						}
					};
				}
			};
			const scope = yield* Scope.make();
			yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
			const context: Omit<DriverOpen, 'signal'> = {
				instance: 'test',
				definition: { description: 'A mailbox', driver: 'email' },
				personal: false,
				configuration: {},
				webhookUrl: 'https://test.example/hooks/test',
				redirectUrl: 'https://test.example/hooks/oauth/callback',
				state: () => 'test-state',
				fetch: globalThis.fetch,
				oauthClient: () => undefined,
				credentials: { load: async () => new Map<string, Json>(), write: async () => undefined },
				emit: async () => undefined,
				status: async () => undefined,
				pairing: () => undefined
			};
			yield* openLink(provider, context).pipe(Scope.provide(scope));
			expect(signal?.aborted).toBe(false);
			yield* Scope.close(scope, Exit.void);
			expect(closed).toBe(true);
			expect(signal?.aborted).toBe(true);
		})
	);
});
