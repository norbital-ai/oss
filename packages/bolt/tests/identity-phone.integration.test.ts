// Phone identity (§5.11.2): a member signs in with their email or their mobile number (a texted code), an invitation
// names either or both, and a workspace that declares `signup` lets a newcomer join by proving their number — bound to
// the record that is them (a guest customer becomes a registered member). An administrator closes sign-up at run time.
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateWindows } from '../src/engine/access/rate.ts';
import type { Json } from '../src/decl/values.ts';
import { DbError, type EngineManifest, type Lock, type Rows, type Sql, type TenantDb, type TransportPort } from '../src/engine/contracts.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { parseAddress } from '../src/engine/identity/address.ts';
import { acceptInvitation, invite, setSignup } from '../src/engine/identity/members.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import { founderBootstrap, loadKeys, sendCode, SIGNUP_TEXTS, verifyCode, type IdentityHost } from '../src/engine/identity/session.ts';

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
	policies: { customer: { description: '', grants: {} }, staff: { description: '', grants: {} } },
	teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;

let pg: PGlite;
let db: TenantDb;
const texts: { to: string; text: string }[] = [];
const mails: { to: string; text: string }[] = [];
const port = (box: { to: string; text: string }[]): TransportPort =>
	({ send: async (_c, msg) => { box.push(msg as { to: string; text: string }); return { providerId: 'x' }; }, subscribe: () => () => {} });
let h: IdentityHost;
const lastCode = () => /(\d{6})/.exec(texts.at(-1)!.text)![1]!;
const one = async (text: string, ...params: Json[]) => (await db.read([{ text, params }]))[0]!.rows;
const authorities = new Authorities(m, 'r1');
const as = async (user: string) => (await authorities.member(db, user))!;
const ip = '5.5.5.5';

beforeAll(async () => {
	pg = new PGlite();
	db = tenantDb(pg);
	await applyPlan(db, plan(null, m), { accept: true });
	// the record a newcomer is: a customer on file by number (as a template's `customers` collection would be)
	await pg.exec(`CREATE TABLE customers (id text PRIMARY KEY, phone text);
		INSERT INTO customers VALUES ('c-ada', '+65 8123 4567'), ('c-twin1', '+6590000000'), ('c-twin2', '+65 9000 0000')`);
	h = { db, now: () => new Date('2026-09-30T00:00:00Z'), windows: new RateWindows(), keys: await loadKeys(db), mail: port(mails), sms: port(texts),
		publicUrl: 'https://acme.example', signup: { via: ['phone'], policies: ['customer'], party: { collection: 'customers', match: { phone: 'phone' } } } };
});
afterAll(() => pg.close());

describe('addresses', () => {
	it('reads an email, or a mobile number with its country code; anything else is refused with a hint', async () => {
		expect(parseAddress(' Ada@Example.com ')).toEqual({ kind: 'email', value: 'Ada@Example.com' });
		expect(parseAddress('+65 8123-4567')).toEqual({ kind: 'phone', value: '+6581234567' });
		expect(parseAddress('81234567')).toBeNull();   // no country code: ambiguous
		expect(parseAddress('ada@')).toBeNull();
		expect(await sendCode(h, '81234567', ip)).toMatchObject({ ok: false, code: 'check', message: expect.stringContaining('country code') });
	});
});

describe('sign-up by mobile number (a guest becomes a member)', () => {
	let ada = '';
	it('a number on file signs up with one texted code: an external member holding the sign-up policies, bound to their record', async () => {
		expect(await sendCode(h, '+6581234567', ip)).toEqual({ ok: true, value: null });
		expect(texts.at(-1)).toMatchObject({ to: '+6581234567', text: expect.stringMatching(/sign-in code is \d{6}/) });
		const s = await verifyCode(h, '+65 8123 4567', lastCode(), ip);
		expect(s.ok).toBe(true);
		ada = s.ok ? s.value.user : '';
		expect(await one('SELECT phone, email, kind, party, admin FROM sys_user WHERE id = $1', ada))
			.toEqual([{ phone: '+6581234567', email: null, kind: 'external', party: { collection: 'customers', id: 'c-ada' }, admin: false }]);
		expect((await as(ada)).policies).toEqual(['customer']);
		expect(await one(`SELECT via FROM sys_session WHERE "user" = $1`, ada)).toEqual([{ via: 'signup' }]);
	});

	it('the same number signs in again as the same member, however it is spelled', async () => {
		await sendCode(h, '+65-8123-4567', ip);
		const s = await verifyCode(h, '+6581234567', lastCode(), ip);
		expect(s.ok && s.value.user).toBe(ada);
		expect(await one(`SELECT count(*)::int AS n FROM sys_user WHERE phone_key = '6581234567'`)).toEqual([{ n: 1 }]);
	});

	it('a newcomer with no record joins unbound, and is bound once their record exists; a number two records hold binds neither', async () => {
		await sendCode(h, '+6591112222', ip);
		const s = await verifyCode(h, '+6591112222', lastCode(), ip);
		const bob = s.ok ? s.value.user : '';
		expect(await one('SELECT party FROM sys_user WHERE id = $1', bob)).toEqual([{ party: null }]);
		await pg.exec(`INSERT INTO customers VALUES ('c-bob', '+6591112222')`);   // the desk files them later
		await sendCode(h, '+6591112222', ip);
		expect((await verifyCode(h, '+6591112222', lastCode(), ip)).ok).toBe(true);
		expect(await one('SELECT party FROM sys_user WHERE id = $1', bob)).toEqual([{ party: { collection: 'customers', id: 'c-bob' } }]);
		await sendCode(h, '+6590000000', ip);
		const twin = await verifyCode(h, '+6590000000', lastCode(), ip);
		expect(await one('SELECT party FROM sys_user WHERE id = $1', twin.ok ? twin.value.user : '')).toEqual([{ party: null }]);
	});

	it('a newcomer is bound to their record as soon as it exists, without signing in again', async () => {
		await sendCode(h, '+6592223333', ip);
		const s = await verifyCode(h, '+6592223333', lastCode(), ip);
		const cid = s.ok ? s.value.user : '';
		const declared = new Authorities({ ...m, workspace: { ...m.workspace, signup: h.signup } } as EngineManifest, 'r2');
		expect((await declared.member(db, cid))!.actor).toMatchObject({ party: null });
		await pg.exec(`INSERT INTO customers VALUES ('c-cy', '+65 9222 3333')`);   // the booking files them
		expect((await declared.member(db, cid))!.actor).toMatchObject({ party: { collection: 'customers', id: 'c-cy' } });
		expect(await one('SELECT party FROM sys_user WHERE id = $1', cid)).toEqual([{ party: { collection: 'customers', id: 'c-cy' } }]);
	});

	it('closed by an administrator, a stranger\'s number is texted nothing and cannot join; a member still signs in', async () => {
		const boss = await founderBootstrap(h, 'boss@acme.example');
		const admin = await as(boss.ok ? boss.value.user : '');
		expect(await setSignup(h, await as(ada), false)).toMatchObject({ code: 'forbidden' });
		expect((await setSignup(h, admin, false)).ok).toBe(true);
		const before = texts.length;
		expect(await sendCode(h, '+6597776666', ip)).toEqual({ ok: true, value: null });   // the same answer…
		expect(texts.length).toBe(before);                                                 // …and no text paid for
		expect(await verifyCode(h, '+6597776666', '000000', ip)).toMatchObject({ ok: false, code: 'invalidCode' });
		await sendCode(h, '+6581234567', ip);
		expect(texts.length).toBe(before + 1);
		expect((await verifyCode(h, '+6581234567', lastCode(), ip)).ok).toBe(true);
		expect((await setSignup(h, admin, true)).ok).toBe(true);
	});

	it('texts to strangers are capped for the whole workspace, however many addresses they come from; members still get theirs', async () => {
		const capped = { ...h, windows: new RateWindows() };
		// sign-ups earlier in this file already counted; each stranger comes from its own address
		let sent = 0, refused: unknown = null;
		for (let i = 0; i <= SIGNUP_TEXTS && refused === null; i++) {
			const r = await sendCode(capped, `+6570000${String(i).padStart(3, '0')}`, `9.9.${i}.1`);
			if (r.ok) sent += 1;
			else refused = r;
		}
		expect(refused).toMatchObject({ ok: false, code: 'rateLimited' });
		expect(sent).toBeLessThan(SIGNUP_TEXTS);
		const before = texts.length;
		expect((await sendCode(capped, '+6581234567', '8.8.8.8')).ok).toBe(true);   // Ada is a member
		expect(texts.length).toBe(before + 1);
	});

	it('a workspace that declares no sign-up texts no stranger, and only invited numbers join', async () => {
		const { signup: _declared, ...closed } = h;
		const before = texts.length;
		expect(await sendCode(closed, '+6593334444', ip)).toEqual({ ok: true, value: null });
		expect(texts.length).toBe(before);
	});
});

describe('invitations by mobile number', () => {
	it('an invitation to a number is texted, and the number signs in as the invited member', async () => {
		const [boss] = await one(`SELECT id FROM sys_user WHERE lower(email) = 'boss@acme.example'`);
		const admin = await as(String(boss!['id']));
		expect(await invite(h, m, admin, {})).toMatchObject({ ok: false, code: 'check' });
		expect(await invite(h, m, admin, { phone: '98765432' })).toMatchObject({ ok: false, code: 'check' });
		const inv = await invite(h, m, admin, { phone: '+44 7700 900123', assignments: [{ policy: 'staff' }] });
		expect(inv.ok).toBe(true);
		expect(texts.at(-1)).toMatchObject({ to: '+447700900123', text: expect.stringContaining('https://acme.example/invite/') });
		const { signup: _declared, ...staff } = h;   // joins by the invitation, not by sign-up
		await sendCode(staff, '+447700900123', ip);
		const s = await verifyCode(staff, '+447700900123', lastCode(), ip);
		expect(s.ok).toBe(true);
		const who = await as(s.ok ? s.value.user : '');
		expect(who.policies).toEqual(['staff']);
		expect(await one(`SELECT via FROM sys_session WHERE "user" = $1`, s.ok ? s.value.user : '')).toEqual([{ via: 'invitation' }]);
	});

	it('an existing member accepts an invitation to their number; a member with another number cannot', async () => {
		const [boss] = await one(`SELECT id FROM sys_user WHERE lower(email) = 'boss@acme.example'`);
		const admin = await as(String(boss!['id']));
		const [ada] = await one(`SELECT id FROM sys_user WHERE phone_key = '6581234567'`);
		const [bob] = await one(`SELECT id FROM sys_user WHERE phone_key = '6591112222'`);
		const inv = await invite(h, m, admin, { phone: '+65 8123 4567', email: 'ada@example.com', assignments: [{ policy: 'staff' }] });
		const id = inv.ok ? inv.value.id : '';
		expect(mails.at(-1)).toMatchObject({ to: 'ada@example.com' });   // both addresses are sent the link
		expect(await acceptInvitation(h, { user: String(bob!['id']) }, id)).toMatchObject({ code: 'forbidden' });
		expect((await acceptInvitation(h, { user: String(ada!['id']) }, id)).ok).toBe(true);
	});
});

describe('one number, one member', () => {
	it('a founder may be a number; a number another member holds is refused', async () => {
		const fresh = new PGlite();
		const fdb = tenantDb(fresh);
		await applyPlan(fdb, plan(null, m), { accept: true });
		const fh = { ...h, db: fdb, keys: await loadKeys(fdb) };
		const f = await founderBootstrap(fh, '+65 6000 0001');
		expect(f.ok).toBe(true);
		expect((await fdb.read([{ text: 'SELECT phone, admin FROM sys_user', params: [] }]))[0]!.rows).toEqual([{ phone: '+6560000001', admin: true }]);
		await expect(fdb.write({ text: `INSERT INTO sys_user (id, name, phone) VALUES ('dup', 'Dup', '6560000001')`, params: [] })).rejects.toThrow();
		await fresh.close();
	});
});
