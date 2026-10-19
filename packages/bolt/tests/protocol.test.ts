import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { HttpServerRequest } from 'effect/unstable/http';
import { needsGuest } from '../src/protocol/http.ts';

const request = (input: Request) => HttpServerRequest.fromWeb(input);
const post = (path: string, body: unknown) =>
	request(
		new Request(`https://w.test${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	);

describe('needsGuest (rule 71, L-COL-107)', () => {
	it.effect('keeps provider callbacks, instance management and files outside guest admission', () =>
		Effect.gen(function* () {
			for (const input of [
				new Request('https://w.test/hooks/oauth/callback?code=x&state=y'),
				new Request('https://w.test/hooks/integration/mail', { method: 'POST' }),
				new Request('https://w.test/__bolt/integrations/mail'),
				new Request('https://w.test/__bolt/integrations/mail/stream'),
				new Request('https://w.test/__bolt/integrations/mail/discover'),
				new Request('https://w.test/__bolt/integrations/mail/pair', { method: 'POST' }),
				new Request('https://w.test/__bolt/integrations/mail/unpair', { method: 'POST' }),
				new Request('https://w.test/__bolt/files/held-file'),
				new Request('https://w.test/__bolt/files/notes.photo', { method: 'PUT' }),
				// Studio's publish cuts its own tenant over: admitted, it would wait out its own drain
				new Request('https://w.test/__bolt/shell/studio', { method: 'POST' })
			])
				expect(yield* needsGuest(request(input))).toBe(false);
			expect(yield* needsGuest(post('/__bolt/integrations/erp/test', {}))).toBe(true);
		})
	);
	it.effect('lets plain reads and the live stream skip the compute envelope', () =>
		Effect.gen(function* () {
			expect(
				yield* needsGuest(
					post('/__bolt/q', {
						reads: [
							{ m: 'read', a: ['t', {}] },
							{ m: 'get', a: ['t', 'x'] }
						]
					})
				)
			).toBe(false);
			expect(
				yield* needsGuest(
					post('/__bolt/live', {
						conn: 'c',
						add: [{ view: 'v', read: { m: 'aggregate', a: ['t', {}] } }]
					})
				)
			).toBe(false);
			expect(yield* needsGuest(post('/__bolt/live', { conn: 'c', drop: ['v'] }))).toBe(false);
			expect(yield* needsGuest(request(new Request('https://w.test/__bolt/live')))).toBe(false);
			expect(yield* needsGuest(request(new Request('https://w.test/__bolt/agent/models')))).toBe(
				false
			);
			expect(
				yield* needsGuest(
					post('/__bolt/live', {
						conn: 'c',
						add: [
							{ view: 't', read: { m: 'transcript', a: ['c'] } },
							{ view: 'l', read: { m: 'conversations', a: [] } }
						]
					})
				)
			).toBe(false);
		})
	);

	it.effect('admits acts, guest queries, similarity and anything unreadable', () =>
		Effect.gen(function* () {
			expect(
				yield* needsGuest(post('/__bolt/act', { callable: 't.create', input: {}, issuedAt: '' }))
			).toBe(true);
			expect(
				yield* needsGuest(
					post('/__bolt/q', {
						reads: [
							{ m: 'get', a: ['t', 'x'] },
							{ m: 'query', a: ['t.open'] }
						]
					})
				)
			).toBe(true);
			expect(
				yield* needsGuest(post('/__bolt/q', { reads: [{ m: 'similar', a: ['t.like'] }] }))
			).toBe(true);
			expect(
				yield* needsGuest(
					request(new Request('https://w.test/__bolt/q', { method: 'POST', body: 'not json' }))
				)
			).toBe(true);
			expect(yield* needsGuest(request(new Request('https://w.test/__bolt/shell')))).toBe(true);
		})
	);
});
