// engine/integrations' merge and engine/pipelines' encoding, pure: one guarantee per test (§3.3.5, rule 30).
import { describe, expect, it } from 'vitest';
import { localChanges, merge, pushFields, type IntegrationData } from '../src/engine/integrations/sync.ts';
import { csv } from '../src/engine/pipelines/pipeline.ts';

const spec = (over: Partial<IntegrationData> = {}): IntegrationData => ({
	direction: 'two_way', source: { connection: 'erp', list: { path: '/c' } }, identity: 'erp_id', policies: ['p'],
	fields: { name: 'name', note: 'note', limit: 'credit_limit', erp_id: 'id' }, ...over,
});
const base = { name: 'a', note: 'n', limit: 1 };

describe('integrations: the per-field merge against the base shadow', () => {
	it('whoever changed a field since the base wins: a remote change is written, a local one is owed a push', () => {
		expect(merge(spec(), base, { ...base, note: 'mine' }, { ...base, name: 'theirs' })).toEqual({ write: { name: 'theirs' }, push: true, conflicts: [] });
	});

	it('both sides changed to the same value have converged: nothing written, nothing owed', () => {
		expect(merge(spec(), base, { ...base, name: 'b' }, { ...base, name: 'b' })).toEqual({ write: {}, push: false, conflicts: [] });
	});

	it('both changed apart: the field rule, else the default (remote_wins), settles it and the conflict is returned', () => {
		const s = spec({ conflicts: { default: 'remote_wins', fields: { note: 'local_wins' } } });
		const r = merge(s, base, { ...base, name: 'L', note: 'L' }, { ...base, name: 'R', note: 'R' });
		expect(r.write).toEqual({ name: 'R' });
		expect(r.push).toBe(true);
		expect(r.conflicts.map((c) => [c.field, c.base, c.local, c.remote, c.rule, c.winner])).toEqual([['name', 'a', 'L', 'R', 'remote_wins', 'remote'], ['note', 'n', 'L', 'R', 'local_wins', 'local']]);
	});

	it('latest: the later side wins; an unknown remote time is the remote', () => {
		const s = spec({ conflicts: { default: 'latest' } });
		const both = [base, { ...base, name: 'L' }, { ...base, name: 'R' }] as const;
		expect(merge(s, ...both, { local: '2026-09-25T10:00:00Z', remote: '2026-09-25T09:00:00Z' }).conflicts[0]!.winner).toBe('local');
		expect(merge(s, ...both, { local: '2026-09-25T10:00:00Z', remote: '2026-09-25T11:00:00Z' }).conflicts[0]!.winner).toBe('remote');
		expect(merge(s, ...both, { local: '2026-09-25T10:00:00Z' }).conflicts[0]!.winner).toBe('remote');
	});

	it('owns.remote always takes the remote; owns.local is never overwritten by a pull', () => {
		const s = spec({ owns: { remote: ['limit'], local: ['note'] } });
		expect(merge(s, base, { ...base, limit: 5, note: 'L' }, { ...base, limit: 9, note: 'R' })).toEqual({ write: { limit: 9 }, push: true, conflicts: [] });
	});

	it('an adoption (no base) makes every difference a conflict; one_way always takes the remote', () => {
		expect(merge(spec(), undefined, { ...base, name: 'L' }, { ...base, name: 'R' }).conflicts).toHaveLength(1);
		expect(merge(spec({ direction: 'one_way' }), base, { ...base, name: 'L' }, { ...base, name: 'R' })).toEqual({ write: { name: 'R' }, push: false, conflicts: [] });
	});

	it('a push owes the plain fields (identity excluded) the row changed since the shadow, never a remote-owned one', () => {
		const s = spec({ owns: { remote: ['limit'] } });
		expect(Object.keys(pushFields(s))).toEqual(['name', 'note', 'limit']);
		expect(localChanges(s, base, { ...base, name: 'x', limit: 7, erp_id: 'E1' })).toEqual(['name']);
	});

	it('converges: any interleaving of edits on either side, settled by a merge and its push, leaves both sides equal', () => {
		let state = 11;
		const rand = (n: number) => { state = (state * 1_103_515_245 + 12_345) % 2 ** 31; return state % n; };
		const s = spec({ owns: { remote: ['limit'], local: ['note'] }, conflicts: { default: 'latest', fields: { name: 'local_wins' } } });
		for (let i = 0; i < 500; i++) {
			const shadow = { name: 'a', note: 'n', limit: 1 };
			const local = { ...shadow }, remote = { ...shadow };
			for (let k = rand(4); k > 0; k--) (rand(2) ? local : remote)[(['name', 'note', 'limit'] as const)[rand(3)]!] = rand(3) as never;
			const m = merge(s, shadow, local, remote, { local: '2026-01-01T00:00:00Z', remote: rand(2) ? '2025-01-01T00:00:00Z' : '2027-01-01T00:00:00Z' });
			const settled = { ...local, ...m.write };
			for (const f of localChanges(s, remote, settled)) (remote as Record<string, unknown>)[f] = settled[f as keyof typeof settled];
			expect({ i, settled }).toEqual({ i, settled: { ...settled, ...remote } });
		}
	});
});

describe('pipelines: export encoding', () => {
	it('csv quotes a field with a comma, quote or line break and doubles its quotes (RFC 4180)', () => {
		expect(csv([['a', 'b'], ['x, y', 'say "hi"'], [null, 2]])).toBe('a,b\r\n"x, y","say ""hi"""\r\n,2');
	});
});
