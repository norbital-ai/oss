import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { needs_guest } from '../src/protocol/http.ts';

const request = (input: Request) => HttpServerRequest.fromWeb(input);
const post = (path: string, body: unknown) =>
	request(
		new Request(`https://w.test${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	);

describe('needs_guest (L-COL-107)', () => {
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
				expect(yield* needs_guest(request(input))).toBe(false);
			expect(yield* needs_guest(post('/__bolt/integrations/erp/test', {}))).toBe(true);
		})
	);
	it.effect('lets plain reads and the live stream skip the compute envelope', () =>
		Effect.gen(function* () {
			expect(
				yield* needs_guest(
					post('/__bolt/q', {
						reads: [
							// a read request is JSON: no guest code reads it
							{ m: 'query', a: [{ t: {} }] },
							{ m: 'query', a: [{ t: { where: { id: { eq: 'x' } } } }] },
							{ m: 'query', a: [{ t: { where: { title: { eq: 'x' } }, lines: {} } }] }
						]
					})
				)
			).toBe(false);
			expect(
				yield* needs_guest(
					post('/__bolt/live', {
						conn: 'c',
						add: [{ view: 'v', read: { m: 'aggregate', a: ['t', {}] } }]
					})
				)
			).toBe(false);
			expect(yield* needs_guest(post('/__bolt/live', { conn: 'c', drop: ['v'] }))).toBe(false);
			expect(yield* needs_guest(request(new Request('https://w.test/__bolt/live')))).toBe(false);
			expect(yield* needs_guest(request(new Request('https://w.test/__bolt/agent/models')))).toBe(
				false
			);
			expect(
				yield* needs_guest(
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

	it.effect('admits acts, index searches, similarity and anything unreadable', () =>
		Effect.gen(function* () {
			expect(
				yield* needs_guest(post('/__bolt/act', { callable: 't.create', input: [{}], issued_at: '' }))
			).toBe(true);
			expect(
				yield* needs_guest(
					post('/__bolt/q', {
						reads: [
							{ m: 'query', a: [{ t: { where: { id: { eq: 'x' } } } }] },
							// a read request's index search probes through the guest
							{ m: 'query', a: [{ t: { search: { like: {} }, limit: 1 } }] }
						]
					})
				)
			).toBe(true);
			expect(
				yield* needs_guest(
					post('/__bolt/q', {
						reads: [{ m: 'query', a: [{ t: { search: { like: {} } } }] }]
					})
				)
			).toBe(true);
			expect(
				yield* needs_guest(
					request(new Request('https://w.test/__bolt/q', { method: 'POST', body: 'not json' }))
				)
			).toBe(true);
			expect(yield* needs_guest(request(new Request('https://w.test/__bolt/shell')))).toBe(true);
		})
	);
});
