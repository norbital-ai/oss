// Durable timing, deadline lifecycle and retry classification; webhook signatures belong to integrations.
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from '@effect/vitest';
import { Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { DeadlinePort } from '../src/engine/ports.ts';
import type { PortFailure } from '../src/engine/port.ts';
import { is_transient } from '../src/engine/errors.ts';
import { BoltError, type Code } from '../src/protocol/errors.ts';
import { due_at } from '../src/engine/runs/time.ts';
import { in_process_deadlines } from '../src/engine/runs/deadlines.ts';
import { verifySignature, type WebhookRequest } from '../src/engine/integrations/webhook.ts';
import type { WebhookScheme } from '../src/decl/runtime/integration.ts';

const at = (s: string) => Date.parse(s);
const iso = (ms: number) => new Date(ms).toISOString();

describe('buckets (rule 52a)', () => {
	it('a due time under 5 minutes ahead is exact; 5 minutes or more rounds up to the bucket', () => {
		const now = at('2026-09-25T09:01:17Z');
		expect(iso(due_at(now, now + 60_000))).toBe('2026-09-25T09:02:17.000Z');
		expect(iso(due_at(now, now + 3 * 86_400_000))).toBe('2026-09-28T09:05:00.000Z');
		expect(iso(due_at(now, at('2026-09-25T09:10:00Z')))).toBe('2026-09-25T09:10:00.000Z');
	});
});

describe('the in-process deadlines port', () => {
	it.effect(
		"wakes a scope once at its earliest instant and re-arms from the tick's settle; idle arms no timer",
		() => {
			const wakes: string[] = [];
			let port: DeadlinePort['Service'];
			const layer = in_process_deadlines<PortFailure, never>({
				wake: (scope) => Effect.gen(function* () {
					wakes.push(`${scope}@${new Date(yield* Clock.currentTimeMillis).toISOString()}`);
					yield* port.settle(scope, wakes.length === 1 ? '2026-09-25T02:00:00.000Z' : null);
				}),
				pulse: () => Effect.succeed(false)
			});
			return Effect.scoped(
				Effect.gen(function* () {
					yield* TestClock.setTime(at('2026-09-25T00:00:00Z'));
					const clock = yield* Clock.Clock;
					let sleeps = 0;
					const started = yield* Deferred.make<void>();
					const observed: Clock.Clock = {
						...clock,
						sleep: (duration) =>
							Effect.sync(() => {
								sleeps++;
								Deferred.doneUnsafe(started, Effect.void);
							}).pipe(
								Effect.andThen(clock.sleep(duration)),
								Effect.ensuring(
									Effect.sync(() => {
										sleeps--;
									})
								)
							)
					};
					yield* Effect.gen(function* () {
						port = Context.get(yield* Layer.build(layer), DeadlinePort);
						yield* port.announce('ws', '2026-09-25T01:00:00.000Z');
						yield* port.announce('ws', '2026-09-25T01:30:00.000Z');
						yield* Deferred.await(started);
						expect(sleeps).toBe(1);
						yield* TestClock.adjust(7 * 86_400_000);
						expect(wakes).toEqual(['ws@2026-09-25T01:00:00.000Z', 'ws@2026-09-25T02:00:00.000Z']);
						expect(sleeps).toBe(0);
					}).pipe(Effect.provideService(Clock.Clock, observed));
				})
			);
		}
	);
	it.effect("an announcement made while the scope wakes is merged with the tick's answer", () => {
		const wakes: string[] = [];
		let port: DeadlinePort['Service'];
		const layer = in_process_deadlines<PortFailure, never>({
			wake: (scope) => Effect.gen(function* () {
				wakes.push(new Date(yield* Clock.currentTimeMillis).toISOString());
				if (wakes.length === 1) yield* port.announce(scope, '2026-09-25T00:10:00.000Z');
				yield* port.settle(scope, wakes.length === 1 ? '2026-09-25T05:00:00.000Z' : null);
			}),
			pulse: () => Effect.succeed(false)
		});
		return Effect.scoped(
			Effect.gen(function* () {
				yield* TestClock.setTime(at('2026-09-25T00:00:00Z'));
				port = yield* DeadlinePort;
				yield* port.announce('ws', '2026-09-25T00:01:00.000Z');
				yield* TestClock.adjust(86_400_000);
				expect(wakes).toEqual(['2026-09-25T00:01:00.000Z', '2026-09-25T00:10:00.000Z']);
			}).pipe(Effect.provide(layer))
		);
	});
	it.effect('the host ABI awaits announce, settle and teardown completion', () =>
		Effect.scoped(Effect.gen(function* () {
			let pending = Promise.withResolvers<void>();
			let entered = yield* Deferred.make<void>();
			const calls: string[] = [];
			const record = (call: string) => {
				calls.push(call);
				Deferred.doneUnsafe(entered, Effect.void);
				return pending.promise;
			};
			const port = Context.get(yield* Layer.build(DeadlinePort.fromAbi({
				announce: (scope, at) => record(`announce:${scope}:${at}`),
				settle: (scope, at) => record(`settle:${scope}:${at}`),
				teardown: (scope) => record(`teardown:${scope}`)
			})), DeadlinePort);
			const operations = [
				{ expected: 'announce:ws:2026-09-25T01:00:00.000Z', effect: port.announce('ws', '2026-09-25T01:00:00.000Z') },
				{ expected: 'settle:ws:null', effect: port.settle('ws', null) },
				{ expected: 'teardown:ws', effect: port.teardown('ws') }
			];
			for (const operation of operations) {
				pending = Promise.withResolvers<void>();
				entered = yield* Deferred.make<void>();
				let finished = false;
				const fiber = yield* operation.effect.pipe(
					Effect.tap(() => Effect.sync(() => { finished = true; })),
					Effect.forkChild
				);
				yield* Deferred.await(entered);
				expect(calls.at(-1)).toBe(operation.expected);
				expect(finished).toBe(false);
				pending.resolve();
				yield* Fiber.join(fiber);
				expect(finished).toBe(true);
			}
			expect(calls).toEqual(operations.map((operation) => operation.expected));
		}))
	);
	it.effect(
		'stays silent about a wake that a stop interrupted, and never wakes again (rule 71a)',
		() =>
			Effect.gen(function* () {
				const errors = vi.spyOn(console, 'error');
				yield* Effect.addFinalizer(() => Effect.sync(() => errors.mockRestore()));
				let calls = 0,
					released = false;
				const scope = yield* Scope.make();
				yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
				const context = yield* Layer.build(
					in_process_deadlines({
						wake: () =>
							Effect.sync(() => {
								calls++;
							}).pipe(
								Effect.andThen(Effect.never),
								Effect.ensuring(
									Effect.sync(() => {
										released = true;
									})
								)
							),
						pulse: () => Effect.succeed(true)
					})
				).pipe(Scope.provide(scope));
				const dk = Context.get(context, DeadlinePort);
				yield* dk.announce('ws', new Date(1).toISOString());
				yield* TestClock.adjust('1 millis');
				expect(calls).toBe(1);
				yield* Scope.close(scope, Exit.void);
				yield* TestClock.adjust('1 second');
				expect([calls, released]).toEqual([1, true]);
				expect(errors).not.toHaveBeenCalled();
			})
	);
	it.effect('a slow deadline cannot starve another scope or overlap itself', () =>
		Effect.gen(function* () {
			const woke: string[] = [],
				held = yield* Deferred.make<void>(),
				scope = yield* Scope.make();
			yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
			const context = yield* Layer.build(
				in_process_deadlines({
					wake: (name) =>
						Effect.sync(() => {
							woke.push(name);
						}).pipe(Effect.andThen(name === 'slow' ? Deferred.await(held) : Effect.void)),
					// a due announcement during the slow wake goes to that wake
					pulse: () => Effect.succeed(true)
				})
			).pipe(Scope.provide(scope));
			const dk = Context.get(context, DeadlinePort);
			yield* dk.announce('slow', new Date(1).toISOString());
			yield* dk.announce('fast', new Date(1).toISOString());
			yield* TestClock.adjust('1 millis');
			expect(woke).toEqual(['slow', 'fast']);
			yield* dk.announce('slow', new Date(1).toISOString());
			yield* TestClock.adjust('1 millis');
			expect(woke).toEqual(['slow', 'fast']);
			yield* Scope.close(scope, Exit.void);
			yield* Deferred.succeed(held, undefined);
			yield* TestClock.adjust('1 millis');
			expect(woke).toEqual(['slow', 'fast']);
		})
	);
});

describe('integration webhook signatures', () => {
	const now = at('2026-09-25T10:00:00Z'),
		ts = String(now / 1000),
		secret = 'shh';
	const body = Buffer.from('{"id":"evt_1"}');
	const hm = (key: string | Buffer, text: string, enc: 'hex' | 'base64') =>
		createHmac('sha256', key).update(text).digest(enc);
	const req = (headers: WebhookRequest['headers']): WebhookRequest => ({
		method: 'POST',
		headers,
		body
	});
	const svixKey = Buffer.from('svix-secret-bytes');
	const cases: [WebhookScheme, string, WebhookRequest][] = [
		['bearer', secret, req({ authorization: 'Bearer shh' })],
		['hmac-sha256', secret, req({ 'x-signature': `sha256=${hm(secret, body.toString(), 'hex')}` })],
		[
			'meta',
			secret,
			req({ 'x-hub-signature-256': `sha256=${hm(secret, body.toString(), 'hex')}` })
		],
		[
			'slack',
			secret,
			req({
				'x-slack-request-timestamp': ts,
				'x-slack-signature': `v0=${hm(secret, `v0:${ts}:${body}`, 'hex')}`
			})
		],
		[
			'stripe',
			secret,
			req({ 'stripe-signature': `t=${ts},v1=${hm(secret, `${ts}.${body}`, 'hex')}` })
		],
		[
			'standard',
			`whsec_${svixKey.toString('base64')}`,
			req({
				'svix-id': 'msg_1',
				'svix-timestamp': ts,
				'svix-signature': `v1,${hm(svixKey, `msg_1.${ts}.${body}`, 'base64')}`
			})
		]
	];
	it.each(cases)(
		'%s: a valid signature passes; a wrong secret, a changed body or a stale timestamp fails',
		(scheme, key, r) => {
			expect(verifySignature(scheme, key, r, now)).toBe(true);
			expect(
				verifySignature(scheme, scheme === 'standard' ? 'whsec_b3RoZXI=' : `${key}x`, r, now)
			).toBe(false);
			expect(verifySignature(scheme, key, { ...r, body: Buffer.from('{"id":"evt_2"}') }, now)).toBe(
				scheme === 'bearer'
			);
			if (['slack', 'stripe', 'standard'].includes(scheme))
				expect(verifySignature(scheme, key, r, now + 600_000)).toBe(false);
		}
	);
	it('standard accepts webhook headers with the same secret, raw-body and freshness checks as Svix headers', () => {
		const key = `whsec_${svixKey.toString('base64')}`;
		const r = req({
			'webhook-id': 'msg_1',
			'webhook-timestamp': ts,
			'webhook-signature': `v1,${hm(svixKey, `msg_1.${ts}.${body}`, 'base64')}`
		});
		expect(verifySignature('standard', key, r, now)).toBe(true);
		expect(verifySignature('standard', 'whsec_b3RoZXI=', r, now)).toBe(false);
		expect(
			verifySignature('standard', key, { ...r, body: Buffer.from('{"id":"evt_2"}') }, now)
		).toBe(false);
		expect(verifySignature('standard', key, r, now + 600_000)).toBe(false);
		expect(verifySignature('svix', key, r, now)).toBe(false);
	});
	it("a scheme it does not declare verifies nothing (a provider's own push is its link's webhook)", () => {
		const google = {
			method: 'POST',
			body: new Uint8Array(),
			headers: {
				'x-goog-channel-token': secret,
				'x-goog-channel-id': 'w',
				'x-goog-resource-id': 'r',
				'x-goog-resource-state': 'exists',
				'x-goog-message-number': '1'
			}
		};
		expect(verifySignature('google-calendar', secret, google, now)).toBe(false);
	});
});

describe('attempts (rule 54)', () => {
	const failed = (code: Code, message = '') => ({
		kind: 'failed' as const,
		error: BoltError.make(code, 'guest', message)
	});
	it('only Transient retries: facility upstream, timeout, rateLimited and an act conflict, thrown or coded', () => {
		expect(is_transient(failed('upstream', '502').error)).toBe(true);
		expect(is_transient(failed('conflict').error)).toBe(true);
		expect(is_transient(failed('timeout').error)).toBe(true);
		expect(is_transient(failed('guest_error', 'TypeError: x is undefined').error)).toBe(false);
		expect(is_transient(failed('cpu_budget').error)).toBe(false);
		expect(is_transient(failed('refused', 'no').error)).toBe(false);
	});
});
