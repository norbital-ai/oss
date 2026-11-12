// The path every chat platform shares: a change log's cursor moves only once what it covers is stored.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider, nothing, recent, type ChatPlatform, type Incoming } from '../../src/chat/adapter.ts';
import { chatProviders, PLATFORMS } from '../../src/chat/index.ts';
import { required, host } from '../kit.ts';
import { connected, webhook } from './kit.ts';

const message = (id: string): Incoming => ({
	id,
	thread: 't1',
	sent_at: '2026-11-05T00:00:00.000Z',
	from: { handle: 'u1', name: null },
	text: id
});
/** A platform whose push carries nothing: every message is read from its change log. */
type ChangeLog = {
	pending: Incoming[];
	asked: (string | null)[];
	gap?: boolean;
	pushed?: Incoming[];
};
const logged = (log: ChangeLog): ChatPlatform => ({
	id: 'logged',
	name: { en: 'Logged', zh: 'Logged' },
	description: { en: 'A change log', zh: 'A change log' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'changes',
	guide: 'https://example.test',
	fields: [],
	connect: async () => ({
		account: 'bot',
		deliver: async () => (log.pushed === undefined ? nothing() : { messages: log.pushed }),
		send: async (_thread, _text, key) => ({ id: key }),
		changes: async (cursor) => {
			log.asked.push(cursor);
			const messages = log.pending;
			return {
				messages,
				cursor: `c${Number((cursor ?? 'c0').slice(1)) + messages.length}`,
				...(log.gap === true ? { gap: true } : {})
			};
		}
	})
});

describe('a platform with a change log', () => {
	it.live('stores what a push points to, and keeps the cursor it reached', () =>
		Effect.gen(function* () {
			const log: ChangeLog = { pending: [], asked: [] };
			const h = yield* connected(logged(log), {});
			log.pending = [message('m1'), message('m2')];
			expect((yield* required(h.link.webhook)(webhook('{}', {}))).status).toBe(200);
			expect(h.events).toHaveLength(2);
			expect(h.values.get('cursor')).toBe('c2');
			log.pending = [];
			yield* required(h.link.webhook)(webhook('{}', {}));
			expect(log.asked.at(-1)).toBe('c2');
		})
	);
	it.live('a failed store keeps the cursor, so the same changes are read again', () =>
		Effect.gen(function* () {
			const log: ChangeLog = { pending: [], asked: [] };
			let refusing = false;
			const h = yield* connected(logged(log), {}, {
				emit: () => (refusing ? Promise.reject(new Error('the store refused')) : Promise.resolve())
			});
			const before = h.values.get('cursor');
			log.pending = [message('m1')];
			refusing = true;
			expect((yield* required(h.link.webhook)(webhook('{}', {}))).status).toBe(500);
			expect(h.values.get('cursor')).toBe(before);
			refusing = false;
			expect((yield* required(h.link.webhook)(webhook('{}', {}))).status).toBe(200);
			expect(h.values.get('cursor')).toBe('c1');
		})
	);
	it.live('a push that carries its message reads no change log, so its files are not fetched twice', () =>
		Effect.gen(function* () {
			const log: ChangeLog = {
				pending: [],
				asked: [],
				pushed: [message('m1')]
			};
			const h = yield* connected(logged(log), {});
			const asked = log.asked.length;
			yield* required(h.link.webhook)(webhook('{}', {}));
			expect(h.events).toHaveLength(1);
			expect(log.asked).toHaveLength(asked);
		})
	);
	it.live('a new pairing starts the log over and forgets the old place', () =>
		Effect.gen(function* () {
			const log: ChangeLog = { pending: [message('m1')], asked: [] };
			const h = yield* connected(logged(log), {});
			expect(log.asked[0]).toBe(null);
			expect(h.values.get('cursor')).toBe('c1');
			log.pending = [];
			yield* required(h.link.pair)({});
			expect(log.asked.at(-1)).toBe(null);
		})
	);
	it.live('a lost place in the log tells a person, on the connection', () =>
		Effect.gen(function* () {
			const log: ChangeLog = { pending: [], asked: [], gap: true };
			const h = yield* connected(logged(log), {});
			expect(h.status).toMatchObject({ state: 'connected', detail: expect.stringContaining('gap') });
		})
	);
});

describe('a platform', () => {
	it.live('that claims more than it implements cannot connect', () =>
		Effect.gen(function* () {
			const log: ChangeLog = { pending: [], asked: [] };
			const h = yield* host(
				chatProvider({ ...logged(log), consistency: 'history' }),
				fetch
			);
			const refused = yield* Effect.flip(required(h.link.pair)({}));
			expect(refused.message).toContain('declares history');
		})
	);
	it('is offered once, says how it reaches the platform, and has its tests', () => {
		expect(new Set(PLATFORMS.map(({ id }) => id)).size).toBe(PLATFORMS.length);
		for (const platform of PLATFORMS) {
			expect(platform.via.en).toMatch(/^(Official API|Via \S+)/);
			expect(existsSync(new URL(`./${platform.id}.test.ts`, import.meta.url))).toBe(true);
		}
	});
	it('tells a person what stays in step before they connect', () => {
		for (const platform of chatProviders())
			expect(platform.setup).toMatchObject({ steps: [{}, { text: { en: expect.any(String) } }] });
	});
	it('depends on no Chat SDK package', () => {
		const manifest = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
		expect(manifest).not.toMatch(/chat-sdk|chat-adapter/);
	});
});

describe('what an adapter may keep per thread', () => {
	it('forgets the oldest key, and a reused key counts as new', () => {
		const held = recent<number>(2);
		held.set('a', 1);
		held.set('b', 2);
		held.set('a', 3);
		held.set('c', 4);
		expect(held.get('a')).toBe(3);
		expect(held.get('b')).toBeUndefined();
		expect(held.get('c')).toBe(4);
	});
});
