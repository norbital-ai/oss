import assert from 'node:assert/strict';
import { describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';
import {
	OP_HEADERS,
	OP_WINDOW_MS,
	signOp,
	verifyOp,
	type NonceStore,
	type OpKey
} from '../src/host-op.ts';

const key: OpKey = { secret: 'test-secret', scope: 'acme' };
const NOW = Date.parse('2026-10-14T00:00:00.000Z');
const body = JSON.stringify({ input: { user: 'u1' } });
/** A durable store as a host keeps one: a nonce is accepted once. */
const store = (): NonceStore & { seen: Set<string> } => {
	const seen = new Set<string>();
	return {
		seen,
		claim: (nonce) =>
			Effect.sync(() => {
				if (seen.has(nonce)) return false;
				seen.add(nonce);
				return true;
			})
	};
};
const request = (headers: { readonly [h: string]: string }) =>
	new Request('https://acme.example/__bolt/ops', { method: 'POST', headers, body });
/** The refusal reason, or the operation name. */
const outcome = (headers: { readonly [h: string]: string }, nonces: NonceStore, signed = body) =>
	verifyOp(key, request(headers), signed, nonces).pipe(
		Effect.catchTag('OpRefused', (e) => Effect.succeed(`refused:${e.reason}`))
	);

describe('std/host-op', () => {
	it.effect('accepts a fresh signed operation once, then refuses its replay', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(NOW);
			const nonces = store(),
				headers = signOp(key, 'acme.example', 'session.mint', body, NOW);
			assert.equal(headers[OP_HEADERS.op], 'session.mint');
			assert.equal(yield* outcome(headers, nonces), 'session.mint');
			assert.equal(yield* outcome(headers, nonces), 'refused:replayed');
		})
	);

	it.effect('refuses a timestamp outside the window either way', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(NOW);
			const nonces = store();
			assert.equal(
				yield* outcome(
					signOp(key, 'acme.example', 'host.ping', body, NOW - OP_WINDOW_MS - 1),
					nonces
				),
				'refused:stale'
			);
			assert.equal(
				yield* outcome(
					signOp(key, 'acme.example', 'host.ping', body, NOW + OP_WINDOW_MS + 1),
					nonces
				),
				'refused:stale'
			);
			assert.equal(
				yield* outcome(signOp(key, 'acme.example', 'host.ping', body, NOW - OP_WINDOW_MS), nonces),
				'host.ping'
			);
			assert.equal(nonces.seen.size, 1);
		})
	);

	it.effect('refuses a bad MAC: another secret, scope, host, operation or body', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(NOW);
			const nonces = store();
			const forged = [
				signOp({ ...key, secret: 'other' }, 'acme.example', 'host.ping', body, NOW),
				signOp({ ...key, scope: 'other' }, 'acme.example', 'host.ping', body, NOW),
				signOp(key, 'other.example', 'host.ping', body, NOW),
				{ ...signOp(key, 'acme.example', 'host.ping', body, NOW), [OP_HEADERS.op]: 'session.mint' }
			];
			for (const headers of forged)
				assert.equal(yield* outcome(headers, nonces), 'refused:badSignature');
			assert.equal(
				yield* outcome(signOp(key, 'acme.example', 'host.ping', body, NOW), nonces, '{}'),
				'refused:badSignature'
			);
			assert.equal(nonces.seen.size, 0);
		})
	);

	it.effect('refuses an unsigned request before anything else', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(NOW);
			const nonces = store(),
				signed = signOp(key, 'acme.example', 'host.ping', body, NOW);
			assert.equal(yield* outcome({}, nonces), 'refused:unsigned');
			assert.equal(
				yield* outcome({ ...signed, [OP_HEADERS.nonce]: 'short' }, nonces),
				'refused:unsigned'
			);
		})
	);
});
