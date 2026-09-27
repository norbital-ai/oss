import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPEN_WINDOWS_SQL, RateWindows } from '../src/engine/access/rate.ts';
import type { Json } from '../src/decl/values.ts';
import { DbError, type EngineManifest, type Lock, type Rows, type Sql, type TenantDb, type TransportPort } from '../src/engine/contracts.ts';
import { Authorities, previewAs } from '../src/engine/identity/actor.ts';
import { eraseUser } from '../src/engine/identity/erase.ts';
import {
	acceptInvitation, assign, authenticateKey, createTeam, deactivate, inspectInvitation, invite, issueKey, moveTeam, revokeKey, rotateKey, setAdmin
} from '../src/engine/identity/members.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import { authenticate, founderBootstrap, loadKeys, mint, sendCode, verifyCode, type IdentityHost } from '../src/engine/identity/session.ts';

// The contract's PGlite adapter in miniature: one transaction per write, locks first, JSON values out.
const json = (v: unknown): Json => v instanceof Date ? v.toISOString() : v as Json;
const rows = (r: { rows: unknown[]; affectedRows?: number }): Rows =>
	({ rows: r.rows.map((row) => Object.fromEntries(Object.entries(row as object).map(([k, v]) => [k, json(v)]))), affected: r.affectedRows ?? 0 });
function tenantDb(pg: PGlite): TenantDb {
	const run = async (tx: Pick<PGlite, 'query'>, s: Sql) => {
		try { return rows(await tx.query(s.text, s.params as unknown[])); } catch (e) {
			const x = e as { code?: string; constraint?: string; message: string };
			throw new DbError(x.code ?? 'XX000', x.message, x.constraint);
		}
	};
	const locked = async (tx: Pick<PGlite, 'query'>, lock?: Lock) => {
		for (const key of lock?.advisory ?? []) await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
	};
	return {
		read: (ss) => Promise.all(ss.map((s) => run(pg, s))),
		write: (s, lock) => pg.transaction(async (tx) => { await locked(tx, lock); return run(tx, s); }),
		transaction: (body, lock) => pg.transaction(async (tx) => { await locked(tx, lock); return body({ query: (s) => run(tx, s) }); }),
	};
}

const m = {
	workspace: { tz: 'UTC', locale: 'en' }, models: {}, relationships: {}, collections: {}, integrations: {}, pipelines: {},
	policies: { sales: { description: '', grants: {} }, finance: { description: '', grants: {} } },
	teams: { Sales: ['sales'] }, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {},
	agent: { skills: {} },
} as unknown as EngineManifest;

let pg: PGlite;
let db: TenantDb;
let clock = Date.parse('2026-09-25T00:00:00Z');
const outbox: { to: string; text: string }[] = [];
const mail: TransportPort = { send: async (_c, msg) => { outbox.push(msg as { to: string; text: string }); return { providerId: 'x' }; }, subscribe: () => () => {} };
let h: IdentityHost;
const lastCode = () => /(\d{6})/.exec(outbox.at(-1)!.text)![1]!;
const one = async (text: string, ...params: Json[]) => (await db.read([{ text, params }]))[0]!.rows;
const authorities = new Authorities(m, 'r1');
const as = async (user: string) => (await authorities.member(db, user))!;

beforeAll(async () => {
	pg = new PGlite();
	db = tenantDb(pg);
	await applyPlan(db, plan(null, m), { accept: true });   // the built-in layer's tables and the engine's private ones
	const keys = await loadKeys(db);
	expect(await loadKeys(db)).toEqual(keys);   // 38a(e): a second cell reads the same secrets
	h = { db, now: () => new Date(clock), windows: new RateWindows(), keys, mail, publicUrl: 'https://acme.example' };
});
afterAll(() => pg.close());

describe('engine/identity (§5.11, rules 37–39)', () => {
	let founder = '';
	it('founder.bootstrap creates the first admin and is idempotent per address; a second founder is refused', async () => {
		const a = await founderBootstrap(h, 'Boss@Acme.example');
		const b = await founderBootstrap(h, 'boss@acme.example');
		expect(a.ok && b.ok && a.value.user === b.value.user).toBe(true);
		founder = a.ok ? a.value.user : '';
		expect(await founderBootstrap(h, 'other@acme.example')).toMatchObject({ ok: false, code: 'forbidden' });
		expect((await as(founder)).admin).toBe(true);
	});

	it('sign-in: same answer for a stranger, 3 attempts per code, single use, session authenticates (rule 38a)', async () => {
		expect(await sendCode(h, 'stranger@x.example', '1.1.1.1')).toEqual({ ok: true, value: null });
		expect(await verifyCode(h, 'stranger@x.example', lastCode(), '1.1.1.1')).toMatchObject({ ok: false, code: 'notMember' });
		await sendCode(h, 'boss@acme.example', '1.1.1.1');
		const code = lastCode(), wrong = code === '000000' ? '000001' : '000000';
		expect(await verifyCode(h, 'boss@acme.example', wrong, '1.1.1.1')).toMatchObject({ code: 'invalidCode' });
		const s = await verifyCode(h, 'boss@acme.example', code, '1.1.1.1');
		expect(s.ok).toBe(true);
		expect(await verifyCode(h, 'boss@acme.example', code, '1.1.1.1')).toMatchObject({ code: 'invalidCode' });   // consumed
		if (s.ok) expect(await authenticate(h, s.value.token)).toMatchObject({ user: founder });
		expect(await one('SELECT count(*)::int AS n FROM sys_session WHERE token_hash = $1', s.ok ? s.value.token : '')).toEqual([{ n: 0 }]);
		await sendCode(h, 'boss@acme.example', '1.1.1.1');
		const c2 = lastCode(), bad = c2 === '111111' ? '222222' : '111111';
		for (let i = 0; i < 3; i++) await verifyCode(h, 'boss@acme.example', bad, '1.1.1.1');
		expect(await verifyCode(h, 'boss@acme.example', c2, '1.1.1.1')).toMatchObject({ code: 'invalidCode' });   // 3 attempts spent it
	});

	it('a mail refusal is returned and nothing is claimed sent (38a(c)); the dev sink uses 123456 (38a(f))', async () => {
		const failing: TransportPort = { send: () => Promise.reject(new Error('smtp down')), subscribe: () => () => {} };
		expect(await sendCode({ ...h, mail: failing }, 'mailfail@acme.example', '9.9.9.1')).toMatchObject({ ok: false, code: 'upstream' });
		await sendCode({ ...h, devSink: true }, 'boss@acme.example', '9.9.9.1');
		expect((await verifyCode(h, 'boss@acme.example', '123456', '9.9.9.1')).ok).toBe(true);
	});

	it('the 6th sendCode for an address in an hour is refused; a fresh cell still refuses it; no plain address is stored (rule 38)', async () => {
		for (let i = 0; i < 5; i++) expect((await sendCode(h, 'flood@acme.example', `3.3.3.${i}`)).ok).toBe(true);
		expect(await sendCode(h, 'flood@acme.example', '3.3.3.9')).toMatchObject({ ok: false, code: 'rateLimited' });
		const fresh = new RateWindows();
		fresh.load((await one(OPEN_WINDOWS_SQL)) as never);
		expect(await sendCode({ ...h, windows: fresh }, 'flood@acme.example', '3.3.3.10')).toMatchObject({ code: 'rateLimited' });
		const stored = JSON.stringify(await one('SELECT * FROM bolt_rate'));
		expect(stored).not.toContain('flood');
		expect(stored).not.toContain('3.3.3.');
	});

	let invited = '';
	it('invitations: admin-only; inspecting changes nothing; the invited address signs in as a member with its assignments (rule 38b)', async () => {
		const boss = await as(founder);
		const team = await createTeam(h, boss, 'Sales');
		const teamId = team.ok ? team.value.id : '';
		const inv = await invite(h, m, boss, { email: 'rep@acme.example', team: teamId, assignments: [{ policy: 'finance' }] });
		expect(inv.ok).toBe(true);
		const id = inv.ok ? inv.value.id : '';
		expect(outbox.at(-1)!.text).toContain(`https://acme.example/invite/${id}`);
		expect(await invite(h, m, boss, { email: 'x@acme.example', assignments: [{ policy: 'ghost' }] })).toMatchObject({ code: 'notFound' });
		const before = await one('SELECT * FROM sys_invitation WHERE id = $1', id);
		expect(await inspectInvitation(h, id)).toMatchObject({ status: 'open', email: 'rep@acme.example' });
		expect(await one('SELECT * FROM sys_invitation WHERE id = $1', id)).toEqual(before);
		await sendCode(h, 'rep@acme.example', '4.4.4.4');
		const s = await verifyCode(h, 'rep@acme.example', lastCode(), '4.4.4.4');
		expect(s.ok).toBe(true);
		invited = s.ok ? s.value.user : '';
		const rep = await as(invited);
		expect([...rep.policies].sort()).toEqual(['finance', 'sales']);
		expect(rep.actor).toMatchObject({ kind: 'member', teamPath: ['Sales'], admin: false });
		expect(await inspectInvitation(h, id)).toMatchObject({ status: 'accepted' });
		expect(await invite(h, m, rep, { email: 'y@acme.example' })).toMatchObject({ code: 'forbidden' });
	});

	it('an expired invitation refuses `expired` unchanged; another address cannot accept', async () => {
		const boss = await as(founder);
		const inv = await invite(h, m, boss, { email: 'late@acme.example' });
		const id = inv.ok ? inv.value.id : '';
		expect(await acceptInvitation(h, { user: invited }, id)).toMatchObject({ code: 'forbidden' });
		clock += 8 * 24 * 3_600_000;
		const before = await one('SELECT * FROM sys_invitation WHERE id = $1', id);
		expect(await acceptInvitation(h, { user: founder }, id)).toMatchObject({ code: 'forbidden' });
		await pg.query(`UPDATE sys_user SET email = 'late@acme.example' WHERE id = $1`, [invited]);
		expect(await acceptInvitation(h, { user: invited }, id)).toMatchObject({ code: 'expired' });
		expect(await one('SELECT * FROM sys_invitation WHERE id = $1', id)).toEqual(before);
		await pg.query(`UPDATE sys_user SET email = 'rep@acme.example' WHERE id = $1`, [invited]);
	});

	it('a team move changes the member’s teamTree and Authority key (rule 37)', async () => {
		const boss = await as(founder);
		const before = await as(invited);
		const parent = await createTeam(h, boss, 'Company');
		const sales = (await one(`SELECT id FROM sys_team WHERE name = 'Sales'`))[0]!.id as string;
		await moveTeam(h, boss, sales, parent.ok ? parent.value.id : null);
		const after = await as(invited);
		expect(after.key).not.toBe(before.key);
		expect(after.actor).toMatchObject({ teamPath: ['Sales', 'Company'] });
		const boss2 = await as(founder);
		expect(boss2.key).toBe((await as(founder)).key);   // cached: same key, same compile
	});

	it('the last active admin cannot be demoted, even by two concurrent demotions; admin ⇒ staff (rule 38c)', async () => {
		const boss = await as(founder);
		expect(await setAdmin(h, boss, founder, false)).toMatchObject({ code: 'lastAdmin' });
		expect((await setAdmin(h, boss, invited, true)).ok).toBe(true);
		const results = await Promise.all([setAdmin(h, boss, founder, false), setAdmin(h, boss, invited, false)]);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(await one('SELECT count(*)::int AS n FROM sys_user WHERE admin AND active')).toEqual([{ n: 1 }]);
		await pg.query(`UPDATE sys_user SET admin = true WHERE id = $1`, [founder]);
		await pg.query(`INSERT INTO sys_user (id, name, kind) VALUES ('ext1', 'Vendor', 'external')`);
		expect(await setAdmin(h, await as(founder), 'ext1', true)).toMatchObject({ code: 'check' });
	});

	it('API keys: shown once, authenticate, rotate, revoke; the key is a principal with assignments', async () => {
		const boss = await as(founder);
		const k = await issueKey(h, boss, 'ci');
		if (!k.ok) throw new Error('issue');
		expect(await authenticateKey(h, k.value.key)).toBe(k.value.id);
		expect(await one('SELECT count(*)::int AS n FROM sys_api_key WHERE hash = $1', k.value.key)).toEqual([{ n: 0 }]);
		await assign(h, m, boss, { type: 'sys_api_key', id: k.value.id }, 'finance');
		expect((await authorities.apiKey(db, k.value.id))!.policies).toEqual(['finance']);
		const r = await rotateKey(h, boss, k.value.id);
		expect(await authenticateKey(h, k.value.key)).toBeNull();
		expect(r.ok && await authenticateKey(h, r.value.key)).toBe(k.value.id);
		await revokeKey(h, boss, k.value.id);
		expect(r.ok && await authenticateKey(h, r.value.key)).toBeNull();
		expect(await authorities.apiKey(db, k.value.id)).toBeNull();
	});

	it('preview-as is admin-only and clears the administrator flag (rule 39)', async () => {
		const boss = await as(founder);
		const p = await previewAs(boss, authorities, db, founder);
		expect(p.authority.admin).toBe(false);
		expect(p.impersonatedBy).toBe(founder);
		await expect(previewAs(await as('ext1'), authorities, db, founder)).rejects.toMatchObject({ code: 'forbidden' });
	});

	it('identity writes keep bolt_history in their statement: member, team, assignment, invitation (§5.11.1)', async () => {
		const history = await one(`SELECT collection, op, actor, changes FROM bolt_history WHERE record::text = $1 ORDER BY at, revision`, invited);
		expect(history[0]).toMatchObject({ collection: 'sys_user', op: 'create', actor: `member:${invited}`, changes: expect.objectContaining({ email: 'rep@acme.example' }) });
		expect(history).toContainEqual({ collection: 'sys_user', op: 'update', actor: `member:${founder}`, changes: { admin: true } });
		expect(await one(`SELECT op FROM bolt_history WHERE collection = 'sys_invitation' AND changes->>'email' = 'rep@acme.example'`)).toEqual([{ op: 'create' }]);
		expect(await one(`SELECT count(*)::int AS n FROM bolt_history WHERE collection = 'sys_assignment' AND changes->>'principal' = $1`, invited)).toEqual([{ n: 1 }]);
		expect(await one(`SELECT op, changes->>'parent' IS NOT NULL AS moved FROM bolt_history WHERE collection = 'sys_team' AND op = 'update'`)).toEqual([{ op: 'update', moved: true }]);
	});

	it('deactivation removes push subscriptions; erase needs an inactive member and leaves no invitation or session (rule 38e(e))', async () => {
		const boss = await as(founder);
		await pg.query(`INSERT INTO bolt_push_subscriptions (id, "user", endpoint, keys) VALUES ('p1', $1, 'https://push', '{}')`, [invited]);
		expect(await eraseUser(h, boss, invited)).toMatchObject({ code: 'active' });
		expect((await deactivate(h, boss, invited)).ok).toBe(true);
		expect(await one('SELECT count(*)::int AS n FROM bolt_push_subscriptions')).toEqual([{ n: 0 }]);
		expect(await mint(h, invited)).toMatchObject({ code: 'notFound' });
		expect((await eraseUser(h, boss, invited)).ok).toBe(true);
		expect(await one(`SELECT email, name FROM sys_user WHERE id = $1`, invited)).toEqual([{ email: null, name: 'Erased member' }]);
		expect(await one(`SELECT count(*)::int AS n FROM sys_invitation WHERE lower(email) = 'rep@acme.example'`)).toEqual([{ n: 0 }]);
		expect(await one(`SELECT count(*)::int AS n FROM sys_session WHERE "user" = $1`, invited)).toEqual([{ n: 0 }]);
		expect(await one(`SELECT count(*)::int AS n FROM sys_assignment WHERE principal = $1`, invited)).toEqual([{ n: 0 }]);
		// the history keeps no personal field and no invitation to the address; the erase is its own revision
		expect(JSON.stringify(await one(`SELECT changes FROM bolt_history WHERE collection = 'sys_user' AND record::text = $1`, invited))).not.toContain('rep@acme.example');
		expect(await one(`SELECT count(*)::int AS n FROM bolt_history WHERE collection = 'sys_invitation' AND changes->>'email' = 'rep@acme.example'`)).toEqual([{ n: 0 }]);
		expect(await one(`SELECT cause FROM bolt_history WHERE record::text = $1 ORDER BY revision DESC LIMIT 1`, invited)).toEqual([{ cause: 'erased' }]);
	});
});
