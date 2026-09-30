import { describe, expect, it } from 'vitest';
import { RateWindows } from '../src/engine/access/rate.ts';
import type { TenantDb } from '../src/engine/contracts.ts';
import { authenticate, defaultName, forget, type IdentityHost } from '../src/engine/identity/session.ts';

/** An identity host whose database answers one session row (or fails), counting reads. */
const host = (answer: () => Promise<unknown[]>) => {
	let clock = Date.parse('2026-09-26T00:00:00Z'), reads = 0;
	const db = {
		read: async () => { reads++; return [{ rows: await answer() }]; },
		write: async () => ({ rows: [] }),
		transaction: async () => { throw new Error('unused'); },
	} as unknown as TenantDb;
	const h: IdentityHost = { db, now: () => new Date(clock), windows: new RateWindows(), keys: { session: Buffer.alloc(32), ipMac: Buffer.alloc(32) }, publicUrl: 'https://w.test' };
	return { h, reads: () => reads, tick: (ms: number) => { clock += ms; } };
};
const row = { id: 's1', user: 'u1', impersonated_by: null, refreshed_at: '2026-09-26T00:00:00Z', expires_at: '2026-10-03T00:00:00Z' };

describe('session memo (L-COL-034)', () => {
	it('reads once per token for 30 s, single-flight, and re-reads after', async () => {
		const t = host(async () => [row]);
		const [a, b] = await Promise.all([authenticate(t.h, 'tok'), authenticate(t.h, 'tok')]);
		expect(a).toEqual({ user: 'u1', session: 's1', impersonatedBy: null, expiresAt: expect.any(Number) });
		expect(b).toEqual(a);
		expect(await authenticate(t.h, 'tok')).toEqual(a);
		expect(t.reads()).toBe(1);
		t.tick(30_001);
		await authenticate(t.h, 'tok');
		expect(t.reads()).toBe(2);
	});

	it('never keeps a miss or a failure, and forgets a signed-out token', async () => {
		let answer: () => Promise<unknown[]> = async () => [];
		const t = host(() => answer());
		expect(await authenticate(t.h, 'tok')).toBeNull();
		answer = async () => { throw new Error('db down'); };
		await expect(authenticate(t.h, 'tok')).rejects.toThrow('db down');
		answer = async () => [row];
		expect(await authenticate(t.h, 'tok')).toMatchObject({ user: 'u1' });
		expect(t.reads()).toBe(3);
		forget(t.h, 'tok');
		answer = async () => [];
		expect(await authenticate(t.h, 'tok')).toBeNull();
	});

	it('is per identity host, so a new generation starts empty', async () => {
		const a = host(async () => [row]), b = host(async () => []);
		expect(await authenticate(a.h, 'tok')).toMatchObject({ user: 'u1' });
		expect(await authenticate(b.h, 'tok')).toBeNull();
	});
});

describe('a new member\'s default name (A12)', () => {
	it('is the email local part as title-cased words, never the raw handle', () => {
		expect(defaultName({ kind: 'email', value: 'mei.ling.tan@x.test' })).toBe('Mei Ling Tan');
		expect(defaultName({ kind: 'email', value: 'ada_lovelace-byron@x.test' })).toBe('Ada Lovelace Byron');
		expect(defaultName({ kind: 'email', value: 'ops@x.test' })).toBe('Ops');
		expect(defaultName({ kind: 'phone', value: '+6581234567' })).toBe('+6581234567');
	});
});
