import { describe, expect, it } from 'vitest';
import { needsGuest } from '../src/protocol/http.ts';

const post = (path: string, body: unknown) => new Request(`https://w.test${path}`, { method: 'POST', body: JSON.stringify(body) });

describe('needsGuest (rule 71, L-COL-107)', () => {
	it('lets plain reads and the live stream skip the compute envelope', async () => {
		expect(await needsGuest(post('/__bolt/q', { reads: [{ m: 'read', a: ['t', {}] }, { m: 'get', a: ['t', 'x'] }] }))).toBe(false);
		expect(await needsGuest(post('/__bolt/live', { conn: 'c', add: [{ view: 'v', read: { m: 'aggregate', a: ['t', {}] } }] }))).toBe(false);
		expect(await needsGuest(post('/__bolt/live', { conn: 'c', drop: ['v'] }))).toBe(false);
		expect(await needsGuest(new Request('https://w.test/__bolt/live'))).toBe(false);
		expect(await needsGuest(new Request('https://w.test/__bolt/agent/models'))).toBe(false);
		expect(await needsGuest(post('/__bolt/live', { conn: 'c', add: [{ view: 't', read: { m: 'transcript', a: ['c'] } }, { view: 'l', read: { m: 'conversations', a: [] } }] }))).toBe(false);
	});

	it('admits acts, guest queries, similarity and anything unreadable', async () => {
		expect(await needsGuest(post('/__bolt/act', { callable: 't.create', input: {}, issuedAt: '' }))).toBe(true);
		expect(await needsGuest(post('/__bolt/q', { reads: [{ m: 'get', a: ['t', 'x'] }, { m: 'query', a: ['t.open'] }] }))).toBe(true);
		expect(await needsGuest(post('/__bolt/q', { reads: [{ m: 'similar', a: ['t.like'] }] }))).toBe(true);
		expect(await needsGuest(new Request('https://w.test/__bolt/q', { method: 'POST', body: 'not json' }))).toBe(true);
		expect(await needsGuest(new Request('https://w.test/__bolt/shell'))).toBe(true);
	});
});
