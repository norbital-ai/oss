// The runs area without a database: buckets (rule 52a), the in-process deadlines port, webhook
// signatures per scheme (rule 56a), and what retries (rule 54).
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Clock, Context, Deferred, Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { DeadlinePort } from '../src/engine/ports.ts';
import type { Unavailable } from '../src/decl/errors.ts';
import { isTransient } from '../src/engine/errors.ts';
import { BoltError, type Code } from '../src/protocol/errors.ts';
import { dueAt } from '../src/engine/runs/time.ts';
import { inProcessDeadlines } from '../src/engine/runs/deadlines.ts';
import { verifySignature, type WebhookRequest } from '../src/engine/runs/webhook.ts';
import type { WebhookScheme } from '../src/decl/runtime/automation.ts';

const at = (s: string) => Date.parse(s);
const iso = (ms: number) => new Date(ms).toISOString();

describe('buckets (rule 52a)', () => {
	it('a due time under 5 minutes ahead is exact; 5 minutes or more rounds up to the bucket', () => {
		const now = at('2026-09-25T09:01:17Z');
		expect(iso(dueAt(now, now + 60_000))).toBe('2026-09-25T09:02:17.000Z');
		expect(iso(dueAt(now, now + 3 * 86_400_000))).toBe('2026-09-28T09:05:00.000Z');
		expect(iso(dueAt(now, at('2026-09-25T09:10:00Z')))).toBe('2026-09-25T09:10:00.000Z');
	});
});

describe('the in-process deadlines port', () => {
	it.effect(
		"wakes a scope once at its earliest instant and re-arms from the tick's settle; idle arms no timer",
		() => {
			const wakes: string[] = [];
			let port: DeadlinePort['Service'];
			const layer = inProcessDeadlines<Unavailable, never>((scope) =>
				Effect.gen(function* () {
					wakes.push(`${scope}@${new Date(yield* Clock.currentTimeMillis).toISOString()}`);
					yield* port.settle(scope, wakes.length === 1 ? '2026-09-25T02:00:00.000Z' : null);
				})
			);
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
		const layer = inProcessDeadlines<Unavailable, never>((scope) =>
			Effect.gen(function* () {
				wakes.push(new Date(yield* Clock.currentTimeMillis).toISOString());
				if (wakes.length === 1) yield* port.announce(scope, '2026-09-25T00:10:00.000Z');
				yield* port.settle(scope, wakes.length === 1 ? '2026-09-25T05:00:00.000Z' : null);
			})
		);
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
});

describe('webhook signatures (rule 56a)', () => {
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
		expect(isTransient(failed('upstream', '502').error)).toBe(true);
		expect(isTransient(failed('conflict').error)).toBe(true);
		expect(isTransient(failed('timeout').error)).toBe(true);
		expect(isTransient(failed('guestError', 'TypeError: x is undefined').error)).toBe(false);
		expect(isTransient(failed('cpuBudget').error)).toBe(false);
		expect(isTransient(failed('refused', 'no').error)).toBe(false);
	});
});
